// SPDX-License-Identifier: Apache-2.0
// The Clean-up tab's collector, run on the fictional sample: the decision model's promises hold on every push.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collect } from '../quality/collectors/cleanup/cleanup.mjs';

test('core is never removable, nothing goes without proof, and the ledger agrees', async () => {
  const m = await collect({ root: process.cwd() });
  for (const id of ['cleanup.core_kept', 'cleanup.proof_kept', 'cleanup.ledger_agrees']) assert.equal(m[id].value, 100, id);
  assert.ok(m['cleanup.check_tokens'].value <= 30 && m['cleanup.summary_tokens'].value <= 150, 'answers stay small');
});
