// SPDX-License-Identifier: Apache-2.0
// Honest ratings: a row without a URL is REVIEW no_url and never copies state to other rows, connections_mark refuses a
// blank URL, and a keep place beats a remove mark in connections_check. Every person here is fictional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { liveConfig, tempDir } from './fake-linkedin.ts';
import { call } from './rpc.ts';

const URL_OF = (slug: string) => `https://www.linkedin.com/in/example-${slug}`;

function setup(rows: string[]) {
  const config = liveConfig();
  const dir = join(tempDir(), 'export');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Connections.csv'), ['First Name,Last Name,URL,Email Address,Company,Position,Connected On', ...rows, ''].join('\n'));
  const overlay = join(tempDir(), 'overlay.json');
  writeFileSync(overlay, JSON.stringify({ places: ['denver'] }));
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LINKEN_GAP: '0-0', LINKEN_RATER: overlay, LINKEN_HALT_FILE: join(tempDir(), 'halt.txt') };
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await call(config, undefined, name, args, env);
    return { isError: r.isError, text: r.content[0].text, json: r.isError ? undefined : JSON.parse(r.content[0].text) };
  };
  return { dir, tool };
}

test('rows with no URL are REVIEW no_url, REMOVE rows are unchanged, and one state never copies to all', async () => {
  const { dir, tool } = setup([
    `Ann,Blank,,,Acme,Analyst,1 Jan 2020`,
    `Bob,Blank,,,Acme,Analyst,1 Jan 2020`,
    `Cy,Sales,${URL_OF('cy')},,Acme,Sales Manager,1 Jan 2020`,
  ]);
  const out = (await tool('archive_load', { path: dir })).json;
  assert.equal(out.by_reason.no_url, 2);
  assert.deepEqual(out.by_tier, { REVIEW: 2, REMOVE: 1 });
  assert.equal((await tool('connections_next')).json.url, URL_OF('cy'));
  assert.ok(!(await tool('connections_mark', { url: URL_OF('cy'), action: 'removed' })).isError);
  await tool('archive_load', { path: dir });
  assert.equal((await tool('connections_list', { reason: 'no_url' })).json.total, 2);
  assert.match((await tool('connections_mark', { url: '  ', action: 'removed' })).text, /URL/);
});

test('a keep place beats a remove mark in connections_check', async () => {
  const { dir, tool } = setup([`Dee,Marked,${URL_OF('dee')},,Acme,Analyst,1 Jan 2020`]);
  await tool('archive_load', { path: dir });
  await tool('connections_mark', { url: URL_OF('dee'), action: 'remove' });
  const page = { url: URL_OF('dee'), name: 'Dee Marked', degree: '1st', location: 'Austin, Texas', headline: 'Analyst' };
  assert.deepEqual((await tool('connections_check', page)).json, { verdict: 'REMOVE', level: 'spam', reason: 'override' });
  assert.match((await tool('connections_check', { ...page, location: 'Denver, Colorado' })).json.reason, /rescue place/);
});
