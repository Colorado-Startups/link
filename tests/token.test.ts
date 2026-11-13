// SPDX-License-Identifier: Apache-2.0
// trusted/link-token: the token reaches `security` on stdin only, a bad shape or a cancel stores nothing. Fake
// osascript and security; the real Keychain is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fake-linkedin.ts';

const SCRIPT = fileURLToPath(new URL('../trusted/link-token', import.meta.url));
const MAC = process.platform === 'darwin' ? false : 'link-token runs on macOS only';

function run(answer: string | null) {
  const dir = tempDir();
  const osa = join(dir, 'osascript');
  const sec = join(dir, 'security');
  writeFileSync(osa, answer === null ? '#!/bin/sh\nexit 1\n' : `#!/bin/sh\nprintf '%s\\n' '${answer}'\n`);
  writeFileSync(sec, `#!/bin/sh\necho "$@" > ${dir}/argv\ncat > ${dir}/stdin\n`);
  chmodSync(osa, 0o755);
  chmodSync(sec, 0o755);
  const r = spawnSync('/bin/sh', [SCRIPT], { env: { PATH: '/usr/bin:/bin', USER: 'member', LINK_OSASCRIPT: osa, LINK_SECURITY: sec }, encoding: 'utf8' });
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : null);
  return { status: r.status, argv: read('argv'), stdin: read('stdin') };
}

test('a good token goes to security on stdin, never in its arguments', { skip: MAC }, () => {
  const r = run('AQX-abc_123.def');
  assert.equal(r.status, 0);
  assert.equal(r.argv, '-i\n');
  assert.equal(r.stdin, 'add-generic-password -U -s link-linkedin -a member -w AQX-abc_123.def\n');
});

test('a cancel, an empty answer or a bad character stores nothing', { skip: MAC }, () => {
  for (const [answer, code] of [[null, 1], ['', 4], ['a b', 4], ['tok;rm', 4]] as const) {
    const r = run(answer);
    assert.equal(r.status, code, String(answer));
    assert.equal(r.stdin, null, 'security never ran');
  }
});
