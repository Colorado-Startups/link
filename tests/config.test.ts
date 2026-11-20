// SPDX-License-Identifier: Apache-2.0
// What the server reads into its config. The token is never part of it (tests/transport.test.ts covers the refusal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configFrom } from '../src/core.ts';

test('an empty environment: no helper, dry-run off, ~/.linken, no gates and the default gate prefix', () => {
  assert.deepEqual(configFrom({}), {
    helper: undefined,
    dryRun: false,
    home: join(homedir(), '.linken'),
    gates: undefined,
    gatePrefix: 'mcp__linken__',
  });
});

test('the config never carries LINKEDIN_ACCESS_TOKEN', () => {
  const config = configFrom({ LINKEDIN_ACCESS_TOKEN: 'fake-token-for-tests' });
  assert.ok(!JSON.stringify(config).includes('fake-token-for-tests'));
});

test('only LINKEN_DRY_RUN=1 turns dry-run on, and each other variable is read as given', () => {
  assert.equal(configFrom({ LINKEN_DRY_RUN: '1' }).dryRun, true);
  for (const value of ['0', 'true', '']) {
    assert.equal(configFrom({ LINKEN_DRY_RUN: value }).dryRun, false, `LINKEN_DRY_RUN=${value}`);
  }
  const config = configFrom({
    LINKEN_HOME: '/data/link',
    LINKEN_HELPER_CMD: '["linken-linkedin"]',
    LINKEN_GATES: '[["check"]]',
    LINKEN_GATE_TOOL_PREFIX: 'mcp__other__',
  });
  assert.equal(config.home, '/data/link');
  assert.equal(config.helper, '["linken-linkedin"]');
  assert.equal(config.gates, '[["check"]]');
  assert.equal(config.gatePrefix, 'mcp__other__');
});
