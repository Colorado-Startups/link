// SPDX-License-Identifier: Apache-2.0
// The Connections-list lane: connections_summary and connections_check_list. Every person here is fictional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { liveConfig, tempDir } from './fake-linkedin.ts';
import { call } from './rpc.ts';

const URL_OF = (slug: string) => `https://www.linkedin.com/in/example-${slug}`;

async function loaded(rows: string[]) {
  const config = liveConfig();
  const dir = join(tempDir(), 'export');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Connections.csv'), ['First Name,Last Name,URL,Email Address,Company,Position,Connected On', ...rows, ''].join('\n'));
  const overlay = join(tempDir(), 'overlay.json');
  writeFileSync(overlay, JSON.stringify({ mission: ['fusion'], places: ['denver'] }));
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LINKEN_GAP: '0-0', LINKEN_RATER: overlay, LINKEN_HALT_FILE: join(tempDir(), 'halt.txt') };
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await call(config, undefined, name, args, env);
    return { isError: r.isError, text: r.content[0].text, json: r.isError ? undefined : JSON.parse(r.content[0].text) };
  };
  await tool('archive_load', { path: dir });
  return tool;
}

const ROWS = [
  `Pat,Pitch,${URL_OF('pat')},,Acme,Sales Manager,1 Jan 2020`,
  `Sam,Sales,${URL_OF('sam')},,Acme,Head of Sales,1 Jan 2020`,
  `Lou,Low,${URL_OF('lou')},,Acme,Analyst,1 Jan 2020`,
];

test('connections_summary after one removed and one skipped mark', async () => {
  const tool = await loaded(ROWS);
  await tool('connections_mark', { url: URL_OF('pat'), action: 'removed' });
  await tool('connections_mark', { url: URL_OF('sam'), action: 'skipped' });
  const s = (await tool('connections_summary')).json;
  assert.deepEqual(s.by_tier, { REMOVE: 3 });
  assert.deepEqual(s.by_reason, { sales: 2, low: 1 });
  assert.deepEqual(s.by_state, { removed: 1, skipped: 1 });
  assert.equal(s.queue, 1);
  assert.deepEqual(s.today, { done: 1, cap: 25 });
  assert.deepEqual(s.sitting, { done: 1, cap: 25 });
  assert.match(s.last_removed, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual([s.last_warning, s.days_since_warning, s.halted], [null, null, false]);
  await tool('connections_mark', { url: URL_OF('lou'), action: 'warning', note: 'test' });
  const w = (await tool('connections_summary')).json;
  assert.deepEqual([w.days_since_warning, w.halted, w.today.done], [0, true, 0]);
});

test('connections_check_list gives one verdict per row, with no degree and an optional location', async () => {
  const tool = await loaded(ROWS);
  const out = await tool('connections_check_list', {
    rows: [
      { url: URL_OF('pat'), name: 'Pat Pitch', headline: 'Sales lead' },
      { url: URL_OF('sam'), name: 'Sam Sales', headline: 'Fusion researcher' },
      { url: URL_OF('lou'), name: 'Lou Low', headline: 'Analyst', location: 'Denver, Colorado' },
    ],
  });
  const v = out.json.verdicts;
  assert.equal(v.length, 3);
  assert.deepEqual(v[0], { url: URL_OF('pat'), verdict: 'REMOVE', reason: 'sales' });
  assert.match(v[1].reason, /mission/);
  assert.match(v[2].reason, /rescue place/);
  assert.deepEqual([v[1].verdict, v[2].verdict], ['SKIP', 'SKIP']);
  assert.equal((await tool('connections_summary')).json.today.done, 0);
  assert.equal((await tool('connections_check_list', { rows: [] })).isError, true);
  assert.equal((await tool('connections_check_list', { rows: [{ url: URL_OF('pat'), name: 'Pat Pitch', headline: '', degree: '2nd' }] })).isError, true);
});
