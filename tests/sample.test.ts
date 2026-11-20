// SPDX-License-Identifier: Apache-2.0
// The try-it sample: tools/sample-export.mjs writes a fictional export that archive_load reads, and every rating
// reason and tier shows up, with exactly two rows that have no profile URL. Every person here is fictional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { archiveLoad } from '../src/archive.ts';
import { connectionsSummary } from '../src/connections.ts';
import { liveConfig, tempDir } from './fake-linkedin.ts';

test('the sample export loads with every tier and reason, and two rows without a URL', async () => {
  const dir = join(tempDir(), 'sample');
  execFileSync(process.execPath, ['tools/sample-export.mjs', dir], { stdio: 'pipe' });
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const overlay = join(tempDir(), 'overlay.json');
  writeFileSync(overlay, JSON.stringify({ mission: ['fusion'] }));
  const config = liveConfig();
  const env = { PATH: process.env.PATH, LINKEN_RATER: overlay };
  const out = await archiveLoad({ path: dir }, config, env);
  const byReason = out.by_reason as Record<string, number>;
  for (const reason of ['thread', 'endorsed', 'new', 'pitch', 'sales', 'mission', 'empty', 'low', 'other', 'no_url']) assert.ok(byReason[reason] > 0, reason);
  assert.equal(byReason.no_url, 2);
  assert.deepEqual(Object.keys(out.by_tier as object).sort(), ['KEEP', 'PROTECTED', 'REMOVE', 'REVIEW']);
  assert.deepEqual(Object.keys(connectionsSummary(config, env).by_level).sort(), ['borderline', 'core', 'low', 'nolink', 'seller', 'spam']);
});
