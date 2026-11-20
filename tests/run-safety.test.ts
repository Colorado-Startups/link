// SPDX-License-Identifier: Apache-2.0
// Run safety: local-date days, the gap from a skip, env caps that only lower, atomic writes and a corrupt removals.json.
// Every person here is fictional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pace } from '../src/connections.ts';
import { liveConfig } from './fake-linkedin.ts';
import { call } from './rpc.ts';

process.env.TZ = 'America/Denver';
const ev = (time: string, action = 'removed') => ({ time, url: 'u', action });

test('days are local dates: 8 pm and 11 pm Denver time are one day, not two UTC days', () => {
  const now = new Date('2026-11-14T06:00:00Z'); // 23:00 on 13 November in Denver
  const p = pace([ev('2026-11-14T03:00:00Z'), ev('2026-11-14T05:30:00Z')], now);
  assert.equal(p.doneToday, 2);
  const nextMorning = new Date('2026-11-14T14:00:00Z'); // 07:00 on 14 November in Denver
  assert.equal(pace([ev('2026-11-14T05:30:00Z')], nextMorning).doneToday, 0);
});

test('the random gap runs from the last removed or skipped event', () => {
  const now = new Date('2026-11-13T12:00:00Z');
  assert.equal(pace([ev('2026-11-13T11:00:00Z'), ev('2026-11-13T11:30:00Z', 'skipped')], now).lastActed, '2026-11-13T11:30:00Z');
  assert.equal(pace([ev('2026-11-13T11:00:00Z')], now).lastActed, '2026-11-13T11:00:00Z');
  assert.equal(pace([], now).lastActed, undefined);
});

test('LINKEN_DAILY_CAP and LINKEN_SITTING_CAP only lower the built-in caps', () => {
  const now = new Date('2026-11-13T12:00:00Z');
  const caps = (env: Record<string, string>) => [pace([], now, env).dailyCap, pace([], now, env).sittingCap];
  assert.deepEqual(caps({}), [25, 25]);
  assert.deepEqual(caps({ LINKEN_DAILY_CAP: '10', LINKEN_SITTING_CAP: '5' }), [10, 5]);
  assert.deepEqual(caps({ LINKEN_DAILY_CAP: '100', LINKEN_SITTING_CAP: '99' }), [25, 25]);
  for (const bad of ['', 'abc', '0', '-3', '2.5', '10x']) assert.deepEqual(caps({ LINKEN_DAILY_CAP: bad, LINKEN_SITTING_CAP: bad }), [25, 25], bad);
});

const seeded = () => {
  const config = liveConfig();
  const c = { first: 'Ann', last: 'Example', url: 'https://www.linkedin.com/in/example-ann', tier: 'REMOVE', reason: 'sales' };
  mkdirSync(config.home, { recursive: true });
  writeFileSync(join(config.home, 'connections.json'), JSON.stringify([c]));
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LINKEN_HOME: config.home, LINKEN_GAP: '0-0', LINKEN_HALT_FILE: join(config.home, 'halt') };
  return { config, tool: (name: string, args: Record<string, unknown> = {}) => call(config, undefined, name, args, env) };
};

test('a corrupt removals.json is a tool error naming the file, and is not overwritten', async () => {
  const { config, tool } = seeded();
  const file = join(config.home, 'removals.json');
  writeFileSync(file, '[{"time":');
  for (const [name, args] of [['connections_next', {}], ['connections_mark', { url: 'https://www.linkedin.com/in/example-ann', action: 'removed' }]] as const) {
    const r = await tool(name, args);
    assert.equal(r.isError, true, name);
    assert.ok(r.content[0].text.includes(file), name);
  }
  assert.equal(readFileSync(file, 'utf8'), '[{"time":');
});

test('writes go through a rename: the marks land and no temp file is left behind', async () => {
  const { config, tool } = seeded();
  assert.ok(!(await tool('connections_mark', { url: 'https://www.linkedin.com/in/example-ann', action: 'removed' })).isError);
  const files = readdirSync(config.home);
  assert.ok(files.includes('removals.json') && files.includes('connections.json'));
  assert.deepEqual(files.filter((f) => f.endsWith('.tmp')), []);
});
