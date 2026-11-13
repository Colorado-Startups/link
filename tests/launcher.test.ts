// SPDX-License-Identifier: Apache-2.0
// The launcher (trusted/link-linkedin): it must never put the token on a command line, where `ps` shows it to every
// local process. It hands the token to Node through a pipe on fd 3 (a here-document, read with --env-file), and keeps
// `env -i`, so Node starts with HOME and the token and nothing else. The runtime tests run a temporary copy of the
// launcher in which only its two absolute paths are swapped: this Node, and a probe script in place of the helper.
// The token is a fake, and the probe never prints it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fake-linkedin.ts';

const LAUNCHER = fileURLToPath(new URL('../trusted/link-linkedin', import.meta.url));
const PROBE = fileURLToPath(new URL('./fixtures/launcher-probe.mjs', import.meta.url));
const VAR = 'LINKEDIN_ACCESS_TOKEN';
const NODE_IN_LAUNCHER = '/opt/homebrew/bin/node';
const HELPER_IN_LAUNCHER = '/usr/local/lib/link/link-linkedin.mjs';
/** A fake token with every kind of character the launcher lets through. */
const FAKE_TOKEN = 'AQX.fake_token:for+tests/0123456789=-';
const NO_DASH = existsSync('/bin/dash') ? false : '/bin/dash is missing on this machine';

const LAUNCHER_TEXT = [
  '#!/bin/dash',
  `case "$${VAR}" in ''|*[!A-Za-z0-9._:+/=-]*) exit 4 ;; esac`,
  `exec /usr/bin/env -i HOME="$HOME" ${NODE_IN_LAUNCHER} --env-file=/dev/fd/3 ${HELPER_IN_LAUNCHER} 3<<EOF`,
  `${VAR}=$${VAR}`,
  'EOF',
  '',
].join('\n');

/** The launcher of PR #1: the token as an argument of `env`. The known-bad sample for the static check. */
const OLD_LAUNCHER_TEXT = `#!/bin/dash\nexec /usr/bin/env -i HOME="$HOME" ${VAR}="$${VAR}" ${NODE_IN_LAUNCHER} ${HELPER_IN_LAUNCHER}\n`;

/**
 * The lines of a launcher that name the token variable anywhere but the two safe places: the `case` line that checks
 * its shape, and the body of the here-document on fd 3. Any other line would put the token in a command's arguments.
 */
function tokenInArguments(text: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.endsWith(' 3<<EOF'));
  const end = start < 0 ? -1 : lines.indexOf('EOF', start + 1);
  return lines.filter((line, index) => {
    if (!line.includes(VAR)) return false;
    const shapeCheck = line.startsWith(`case "$${VAR}" in `);
    const hereDocument = start >= 0 && index > start && index < end;
    return !shapeCheck && !hereDocument;
  });
}

/** A temporary copy of the launcher that starts this Node and the probe. Returns its path and the probe's marker. */
function stage(): { launcher: string; ran: string } {
  const dir = tempDir();
  const probe = join(dir, 'probe.mjs');
  copyFileSync(PROBE, probe);
  writeFileSync(join(dir, 'expected'), FAKE_TOKEN);
  assert.ok(!/\s/.test(process.execPath + probe), 'the swapped-in paths hold no whitespace');
  const text = readFileSync(LAUNCHER, 'utf8');
  for (const path of [NODE_IN_LAUNCHER, HELPER_IN_LAUNCHER]) {
    assert.equal(text.split(path).length - 1, 1, `${path} appears once in the launcher`);
  }
  const launcher = join(dir, 'link-linkedin');
  writeFileSync(launcher, text.replace(NODE_IN_LAUNCHER, process.execPath).replace(HELPER_IN_LAUNCHER, probe));
  return { launcher, ran: join(dir, 'ran') };
}

function start(launcher: string, env: Record<string, string>, input: string) {
  return spawnSync('/bin/dash', [launcher], { input, env, encoding: 'utf8' });
}

test('the launcher is the reviewed five lines, and it is executable', () => {
  assert.equal(readFileSync(LAUNCHER, 'utf8'), LAUNCHER_TEXT);
  assert.equal(statSync(LAUNCHER).mode & 0o111, 0o111);
});

test('the token variable is in no command\'s arguments: only the shape check and the here-document name it', () => {
  const text = readFileSync(LAUNCHER, 'utf8');
  assert.deepEqual(tokenInArguments(text), []);
  const lines = text.split('\n');
  const execLine = lines.findIndex((line) => line.startsWith('exec '));
  assert.deepEqual(lines.slice(execLine + 1, lines.indexOf('EOF')), [`${VAR}=$${VAR}`], 'the here-document is one line');

  // The check itself: it catches the old launcher, and a token moved onto the exec line or echoed.
  assert.equal(tokenInArguments(OLD_LAUNCHER_TEXT).length, 1);
  assert.equal(tokenInArguments(text.replace(' 3<<EOF', ` "$${VAR}" 3<<EOF`)).length, 1);
  assert.equal(tokenInArguments(text.replace('exec ', `echo "$${VAR}"\nexec `)).length, 1);
});

test('the launcher hands Node the token through a pipe: HOME and the token only, and stdin untouched', { skip: NO_DASH }, () => {
  const { launcher, ran } = stage();
  const input = '{"method":"GET","url":"https://api.linkedin.com/v2/userinfo","note":"a \\" quote, é and 🚀"}\nsecond line\n';
  const result = start(
    launcher,
    { HOME: '/home/fake', [VAR]: FAKE_TOKEN, NODE_OPTIONS: '--no-warnings', PATH: '/nonexistent', LINK_TEST_JUNK: 'junk' },
    input,
  );
  assert.equal(result.stderr, '');
  assert.equal(result.status, 0);
  assert.ok(!result.stdout.includes(FAKE_TOKEN), 'the probe never prints the token');
  const report = JSON.parse(result.stdout) as { names: string[] };
  // macOS gives every process __CF_USER_TEXT_ENCODING when it starts without one, even under a bare `env -i`. It is
  // not the launcher's, so it is set aside on macOS only. On Linux the list must match as it is.
  if (process.platform === 'darwin') report.names = report.names.filter((name) => name !== '__CF_USER_TEXT_ENCODING');
  assert.deepEqual(report, {
    tokenArrived: true,
    names: ['HOME', VAR],
    stdin: input,
    args: [],
    nodeOptions: ['--env-file=/dev/fd/3'],
    fd3: 'pipe',
  });
  assert.equal(existsSync(ran), true);
});

test('an empty token, or one with a character outside the key shape, exits 4 and starts nothing', { skip: NO_DASH }, () => {
  const refused: Record<string, string | undefined> = {
    unset: undefined,
    empty: '',
    'a space': 'fake token',
    'a trailing space': 'fake-token ',
    'a newline': 'fake\ntoken',
    'a tab': 'fake\ttoken',
    'a double quote': 'fake"token',
    'a single quote': "fake'token",
    'a hash': 'fake#token',
    'a dollar': 'fake$HOME',
    'a backtick': 'fake`id`',
    'a backslash': 'fake\\token',
    'a semicolon': 'fake;token',
    'a non-ASCII letter': 'fakétoken',
  };
  for (const [name, token] of Object.entries(refused)) {
    const { launcher, ran } = stage();
    const result = start(launcher, { HOME: '/home/fake', ...(token === undefined ? {} : { [VAR]: token }) }, 'ignored');
    assert.equal(result.status, 4, name);
    assert.equal(result.stdout + result.stderr, '', name);
    assert.equal(existsSync(ran), false, `${name}: Node never started`);
  }
});
