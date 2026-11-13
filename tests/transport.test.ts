// SPDX-License-Identifier: Apache-2.0
// The default transport: it runs the LINK_HELPER_CMD command without a shell and with a minimal environment, hands it
// the spec on stdin, and maps each exit code to an error that names the fix. It starts nothing while the token is in
// the server's own environment. The helpers here are small Node programs; none reaches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LinkError, childEnv, helperTransport, type Spec } from '../src/linkedin.ts';
import { tempDir } from './fake-linkedin.ts';

const SPEC: Spec = {
  method: 'POST',
  url: 'https://api.linkedin.com/rest/posts?secret=query',
  headers: { 'Linkedin-Version': '202610' },
  json: { commentary: 'Hello' },
};
const TOKEN_SHAPED = 'AQXfakeTokenShapedString0123456789';

/** LINK_HELPER_CMD for a Node one-liner, with any extra arguments after it. */
function helper(script: string, ...args: string[]): string {
  return JSON.stringify([process.execPath, '-e', script, ...args]);
}

/** The message of the LinkError the transport throws. `env` stands for the server's own environment. */
async function failure(raw: string | undefined, env: Record<string, string | undefined> = {}): Promise<string> {
  const error = await helperTransport(raw, env)(SPEC).then(
    () => null,
    (thrown: unknown) => thrown,
  );
  assert.ok(error instanceof LinkError, `expected a LinkError, got ${String(error)}`);
  return error.message;
}

test('exit 0: the spec arrives on stdin as JSON, and the result on stdout comes back', async () => {
  const echo =
    "let s='';process.stdin.on('data',(d)=>(s+=d)).on('end',()=>process.stdout.write(JSON.stringify({status:201,headers:{'x-restli-id':'urn:li:share:1'},body:JSON.parse(s)})))";
  const result = await helperTransport(helper(echo), {})(SPEC);
  assert.deepEqual(result, { status: 201, headers: { 'x-restli-id': 'urn:li:share:1' }, body: SPEC });
});

test('the command runs without a shell: its arguments arrive exactly as written', async () => {
  const args = ['$(echo injected)', ';', '&&', '`id`', 'two words'];
  const show = 'process.stdout.write(JSON.stringify({status:200,headers:{},body:process.argv.slice(1)}))';
  const result = await helperTransport(helper(show, ...args), {})(SPEC);
  assert.deepEqual(result.body, args);
});

test('each helper exit code becomes an error that names the fix', async () => {
  const where = 'POST api.linkedin.com/rest/posts';
  const cases: [string, string][] = [
    ["process.stdout.write('{\"error\":\"host not allowed\"}');process.exit(2)", `The LinkedIn helper refused ${where}: host not allowed.`],
    ['process.exit(2)', `The LinkedIn helper refused ${where}: no reason given.`],
    ["process.stdout.write('{\"error\":\"not approved\"}');process.exit(3)", 'You cancelled in the approval dialog. Nothing was sent.'],
    ['process.exit(4)', "The LinkedIn helper had no usable token. Generate one in LinkedIn's Token Generator and store it (about 1 minute), and check that LINK_HELPER_CMD starts the helper through the key tool."],
    ['process.exit(5)', `Could not reach LinkedIn (${where}). Check the network. If this was the post itself, check the profile before trying again.`],
    ['process.exit(1)', 'The LinkedIn helper command failed (exit 1). Check LINK_HELPER_CMD and that the token is stored.'],
    ["process.stdout.write('not json')", `The LinkedIn helper returned no result for ${where}. Check the profile before trying again.`],
    ["process.stdout.write('null')", `The LinkedIn helper returned no result for ${where}. Check the profile before trying again.`],
  ];
  for (const [script, message] of cases) {
    assert.equal(await failure(helper(script)), message, script);
  }
});

test('a command that does not exist is reported as such', async () => {
  assert.equal(
    await failure(JSON.stringify(['/nonexistent/link-linkedin'])),
    'Could not start the LinkedIn helper. Check that the command in LINK_HELPER_CMD exists.',
  );
});

test('LINK_HELPER_CMD unset or malformed: the error names the variable and shows the shape', async () => {
  const example =
    'Set it to the command that starts the helper with the token, as a JSON array of strings, for example ["/bin/sh","-c","LINKEDIN_ACCESS_TOKEN=\\"$(/usr/bin/security find-generic-password -s link-linkedin -w)\\" exec /usr/local/bin/link-linkedin"].';
  assert.equal(await failure(undefined), `LINK_HELPER_CMD is not set. ${example}`);
  for (const raw of ['link-linkedin', '"link-linkedin"', '[]', '["node", 1]', '[""]', '{"cmd":"x"}']) {
    assert.equal(await failure(raw), `LINK_HELPER_CMD is not valid. ${example}`, raw);
  }
});

test("nothing a helper writes to stderr, and no query string, reaches an error message", async () => {
  for (const exit of [0, 1, 2, 3, 4, 5]) {
    const noisy = `process.stderr.write('Bearer ${TOKEN_SHAPED}');process.exit(${exit})`;
    const message = await failure(helper(noisy));
    assert.ok(!message.includes(TOKEN_SHAPED), `exit ${exit}: ${message}`);
    assert.ok(!message.includes('secret=query'), `exit ${exit}: ${message}`);
  }
});

test("with the token in the server's own environment, the transport refuses and starts nothing", async () => {
  const marker = join(tempDir(), 'helper-ran');
  const leaveMarker = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');process.stdout.write('{"status":200,"headers":{},"body":null}')`;
  const refusal =
    "LINKEDIN_ACCESS_TOKEN is set in the Link server's environment. The server must not hold the token. Remove it and let the helper command supply the token (for example a key tool that starts link-linkedin).";
  for (const raw of [helper(leaveMarker), undefined, 'not json']) {
    assert.equal(await failure(raw, { LINKEDIN_ACCESS_TOKEN: 'fake-token-for-tests', PATH: process.env.PATH }), refusal);
  }
  assert.equal(existsSync(marker), false, 'the helper command never ran');

  // The same command runs once the token is gone, so the refusal above came from the token alone.
  for (const env of [{}, { LINKEDIN_ACCESS_TOKEN: '' }]) {
    assert.equal((await helperTransport(helper(leaveMarker), env)(SPEC)).status, 200);
  }
  assert.equal(existsSync(marker), true);
});

test('the helper command starts with five variables at most, never the token, NODE_OPTIONS, BASH_ENV or ENV', async () => {
  const serverEnv = {
    HOME: '/home/fake',
    USER: 'fake',
    LOGNAME: 'fake',
    PATH: '/usr/bin:/bin',
    TMPDIR: '/tmp',
    NODE_OPTIONS: '--no-warnings',
    BASH_ENV: '/nonexistent/bash-env',
    ENV: '/nonexistent/env',
    LINK_TEST_OTHER: 'anything else the server has',
  };
  // The pure part, with the token present too.
  assert.deepEqual(childEnv({ ...serverEnv, LINKEDIN_ACCESS_TOKEN: 'fake-token-for-tests' }), {
    HOME: '/home/fake',
    USER: 'fake',
    LOGNAME: 'fake',
    PATH: '/usr/bin:/bin',
    TMPDIR: '/tmp',
  });
  assert.deepEqual(childEnv({ PATH: '/usr/bin', NODE_OPTIONS: '--no-warnings' }), { PATH: '/usr/bin' });

  // The real spawn: a stand-in helper reports the names of the variables it started with, never a value.
  const envNames = fileURLToPath(new URL('./fixtures/env-names.mjs', import.meta.url));
  const result = await helperTransport(JSON.stringify([process.execPath, envNames]), { ...serverEnv, LINKEDIN_ACCESS_TOKEN: '' })(SPEC);
  const names = result.body as string[];
  for (const excluded of ['LINKEDIN_ACCESS_TOKEN', 'NODE_OPTIONS', 'BASH_ENV', 'ENV', 'LINK_TEST_OTHER']) {
    assert.ok(!names.includes(excluded), `${excluded} reached the helper command`);
  }
  for (const kept of ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR']) {
    assert.ok(names.includes(kept), `${kept} did not reach the helper command`);
  }
});
