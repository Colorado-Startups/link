// SPDX-License-Identifier: Apache-2.0
// Pre-publish gates (LINK_GATES): run before post_publish acts, live and in a dry run. Exit 0 passes and may warn,
// exit 2 blocks before the transport is called, and anything else is "could not verify" and does not block. The gates
// are the small scripts in tests/fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { fakeLinkedIn, liveConfig, POST_URN } from './fake-linkedin.ts';
import { call } from './rpc.ts';

const fixture = (name: string) => [process.execPath, fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))];
const PASS = [process.execPath, '-e', ''];
const WARN = fixture('gate-warn.mjs');
const BLOCK = fixture('gate-block.mjs');
const BROKEN = fixture('gate-broken.mjs');

/** Calls post_publish with the given gates and returns the result, its parsed value and the transport's calls. */
async function publish(gates: unknown, extra: { dryRun?: boolean; gatePrefix?: string } = {}) {
  const linkedin = fakeLinkedIn();
  const config = { ...liveConfig(), gates: typeof gates === 'string' ? gates : JSON.stringify(gates), ...extra };
  const result = await call(config, linkedin.transport, 'post_publish', { text: 'Gated post' });
  const value = result.isError ? null : JSON.parse(result.content[0].text);
  return { result, value, calls: linkedin.calls };
}

test('pass: gates that exit 0 with nothing to say leave the result as it is', async () => {
  const { value, calls } = await publish([PASS, PASS]);
  assert.equal(value.urn, POST_URN);
  assert.equal('gate_warnings' in value || 'gate_could_not_verify' in value, false);
  assert.equal(calls.length, 2);
});

test('no gates: LINK_GATES unset, empty or [] runs nothing', async () => {
  for (const gates of [undefined, '', '[]']) {
    const linkedin = fakeLinkedIn();
    const result = await call({ ...liveConfig(), gates }, linkedin.transport, 'post_publish', { text: 'x' });
    assert.notEqual(result.isError, true, String(gates));
    assert.equal(linkedin.calls.length, 2);
  }
});

test('warn: additionalContext comes back under gate_warnings, and the gate saw the PreToolUse hook shape', async () => {
  const { value, calls } = await publish([WARN]);
  assert.deepEqual(value.gate_warnings, ['PreToolUse mcp__link__post_publish text=Gated post']);
  assert.equal(value.urn, POST_URN);
  assert.equal(calls.length, 2);

  const renamed = await publish([WARN], { gatePrefix: 'mcp__plugin_link__' });
  assert.deepEqual(renamed.value.gate_warnings, ['PreToolUse mcp__plugin_link__post_publish text=Gated post']);
});

test('block: exit 2 is a tool error with the gate\'s stderr, and the transport is never called', async () => {
  const { result, calls } = await publish([PASS, BLOCK, WARN]);
  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    'Blocked by a pre-publish gate. Nothing was sent. The halt file is present: posting is paused.',
  );
  assert.equal(calls.length, 0);
});

test('could not verify: another exit code or a command that will not start is noted and does not block', async () => {
  const { value, calls } = await publish([BROKEN, ['/nonexistent/python3', '/abs/halt_check.py', '--hook'], WARN]);
  assert.deepEqual(value.gate_could_not_verify, ['gate-broken.mjs: exit 3', 'halt_check.py: could not start']);
  assert.equal(value.gate_warnings.length, 1);
  assert.equal(value.urn, POST_URN);
  assert.equal(calls.length, 2);
});

test('gates run in a dry run too: a warning is kept, and a block stops the dry run', async () => {
  const warned = await publish([WARN], { dryRun: true });
  assert.equal(warned.value.dry_run, true);
  assert.equal(warned.value.gate_warnings.length, 1);
  const blocked = await publish([BLOCK], { dryRun: true });
  assert.equal(blocked.result.isError, true);
  assert.match(blocked.result.content[0].text, /^Blocked by a pre-publish gate\. Nothing was sent\./);
  assert.equal(warned.calls.length + blocked.calls.length, 0);
});

test('LINK_GATES that is not a JSON array of argument arrays is a clear tool error, before anything is sent', async () => {
  for (const gates of ['not json', '{"a":1}', '["python3 check.py"]', '[[]]', '[["python3", 1]]', '[[""]]']) {
    const { result, calls } = await publish(gates);
    assert.equal(result.isError, true, gates);
    assert.equal(
      result.content[0].text,
      'LINK_GATES is not valid. Set it to a JSON array of argument arrays, for example [["python3","/abs/check.py","--hook"]].',
    );
    assert.equal(calls.length, 0);
  }
});

test('link_status is a read: no gate runs for it', async () => {
  const linkedin = fakeLinkedIn();
  const result = await call({ ...liveConfig(), gates: JSON.stringify([BLOCK]) }, linkedin.transport, 'link_status');
  assert.notEqual(result.isError, true);
});
