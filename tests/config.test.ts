// SPDX-License-Identifier: Apache-2.0
// What the server reads into its config. The token is never part of it (tests/transport.test.ts covers the refusal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configFrom } from '../src/linkedin.ts';

test('an empty environment: no helper, dry-run off, ~/.link, no gates and the default gate prefix', () => {
  assert.deepEqual(configFrom({}), {
    helper: undefined,
    dryRun: false,
    home: join(homedir(), '.link'),
    gates: undefined,
    gatePrefix: 'mcp__link__',
  });
});

test('the config never carries LINKEDIN_ACCESS_TOKEN', () => {
  const config = configFrom({ LINKEDIN_ACCESS_TOKEN: 'fake-token-for-tests' });
  assert.ok(!JSON.stringify(config).includes('fake-token-for-tests'));
});

test('only LINK_DRY_RUN=1 turns dry-run on, and each other variable is read as given', () => {
  assert.equal(configFrom({ LINK_DRY_RUN: '1' }).dryRun, true);
  for (const value of ['0', 'true', '']) {
    assert.equal(configFrom({ LINK_DRY_RUN: value }).dryRun, false, `LINK_DRY_RUN=${value}`);
  }
  const config = configFrom({
    LINK_HOME: '/data/link',
    LINK_HELPER_CMD: '["link-linkedin"]',
    LINK_GATES: '[["check"]]',
    LINK_GATE_TOOL_PREFIX: 'mcp__other__',
  });
  assert.equal(config.home, '/data/link');
  assert.equal(config.helper, '["link-linkedin"]');
  assert.equal(config.gates, '[["check"]]');
  assert.equal(config.gatePrefix, 'mcp__other__');
});
