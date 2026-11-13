// SPDX-License-Identifier: Apache-2.0
// The connections feature: the CSV reader, the rater (one case per rule), archive_load on a tiny made-up export, and
// the pace, halt, check and re-load behavior of the other four tools. Every person here is fictional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv, records } from '../src/csv.ts';
import { gapRange, pace } from '../src/connections.ts';
import { loadKeep, loadRules, rate, type Row, type Rules } from '../src/rater.ts';
import { liveConfig, tempDir } from './fake-linkedin.ts';
import { call } from './rpc.ts';

test('the CSV reader keeps quoted commas, doubled quotes and line breaks, and skips a preamble', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi""\nbye"\r\nlast,'), [['a', 'b'], ['x, y', 'say "hi"\nbye'], ['last', '']]);
  assert.deepEqual(records('Notes:\n"A long\nnote"\n\nFirst Name,Last Name\nAda,Example\n', 'first name'), [{ 'first name': 'Ada', 'last name': 'Example' }]);
});

const NOW = new Date('2026-11-13T12:00:00Z');
const RULES: Rules = { new_days: 90, low_days: 365, pitch: [], sales: ['sales'], mission: ['fusion'], places: ['denver'], keep_files: [] };
const row = (over: Partial<Row>): Row => ({
  first: 'Ada', last: 'Example', url: 'https://www.linkedin.com/in/example-ada', email: '', company: 'Acme', position: 'Analyst',
  connected: '2024-01-01', sent: 0, received: 0, started: false, endorsed: false, pitchFirst: false, keep: false, ...over,
});

test('the rater: one case per rule, first match wins', () => {
  const cases: [string, Partial<Row>, string, string][] = [
    ['1 mark keep', { mark: 'keep', position: 'Sales' }, 'KEEP', 'override'],
    ['1 mark remove', { mark: 'remove', started: true }, 'REMOVE', 'override'],
    ['2 started a thread', { started: true, pitchFirst: true }, 'PROTECTED', 'thread'],
    ['2 sent two messages', { sent: 2 }, 'PROTECTED', 'thread'],
    ['3 endorsed', { endorsed: true, position: 'Sales' }, 'PROTECTED', 'endorsed'],
    ['4 keep list', { keep: true, position: 'Sales' }, 'PROTECTED', 'keeplist'],
    ['5 new', { connected: '2026-10-20', position: 'Sales' }, 'PROTECTED', 'new'],
    ['5 new but pitching', { connected: '2026-10-20', pitchFirst: true }, 'REMOVE', 'pitch'],
    ['6 pitch', { pitchFirst: true, position: 'Fusion engineer' }, 'REMOVE', 'pitch'],
    ['6 pitch, but you replied once', { pitchFirst: true, sent: 1, received: 1 }, 'REVIEW', 'other'],
    ['7 sales', { position: 'Head of Sales', company: 'Fusion Labs' }, 'REMOVE', 'sales'],
    ['8 mission in position', { position: 'Fusion engineer' }, 'KEEP', 'mission'],
    ['8 place in company', { company: 'Denver Bank' }, 'KEEP', 'mission'],
    ['9 empty', { position: '', company: ' ' }, 'REMOVE', 'empty'],
    ['10 low', {}, 'REMOVE', 'low'],
    ['10 not low: messages', { received: 1 }, 'REVIEW', 'other'],
    ['11 other', { connected: '2026-03-01' }, 'REVIEW', 'other'],
  ];
  for (const [label, over, tier, reason] of cases) assert.deepEqual(rate(row(over), RULES, NOW), { tier, reason }, label);
});

test('a LINK_RATER overlay joins lists, replaces numbers and leaves the default alone', () => {
  const file = join(tempDir(), 'overlay.json');
  writeFileSync(file, JSON.stringify({ mission: ['geothermal'], places: ['denver'], low_days: 200 }));
  const merged = loadRules({ LINK_RATER: file });
  assert.deepEqual([merged.mission, merged.places, merged.low_days], [['geothermal'], ['denver'], 200]);
  assert.ok(merged.sales.includes('recruiter'));
  assert.deepEqual(loadRules({}).mission, []);
});

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ago = (days: number) => {
  const d = new Date(Date.now() - days * 86_400_000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
const URL_OF = (slug: string) => `https://www.linkedin.com/in/example-${slug}`;
const PEOPLE: [string, string, string, string, number][] = [
  // first, last, position, company, days since connected
  ['Pat', 'Pitch', 'Analyst', 'Acme', 800],
  ['Tom', 'Thread', 'Analyst', 'Acme', 800],
  ['Sam', 'Sales', 'Sales Manager', 'Acme', 800],
  ['Nia', 'Nobody', '', '', 800],
  ['Lou', 'Low', 'Analyst', 'Acme', 800],
  ['Neo', 'New', 'Analyst', 'Acme', 10],
  ['Eve', 'Endorser', 'Analyst', 'Acme', 800],
  ['Kay', 'Keep', 'Analyst', 'Acme', 800],
  ['Quentin', 'Quote', 'Line one\nLine two', 'Acme, Inc', 200],
];

/** A tiny export in a fresh folder: Connections.csv with a preamble, messages, an endorsement file, an invitation file. */
function exportFolder(): string {
  const dir = join(tempDir(), 'export', 'Basic_LinkedInDataExport');
  mkdirSync(dir, { recursive: true });
  const q = (s: string) => `"${s.replaceAll('"', '""')}"`;
  const connections = PEOPLE.map(([f, l, p, c, d]) => [f, l, URL_OF(f.toLowerCase()), '', q(c), q(p), ago(d)].join(','));
  writeFileSync(join(dir, 'Connections.csv'), ['Notes:', '"Made up, for tests."', '', 'First Name,Last Name,URL,Email Address,Company,Position,Connected On', ...connections, ''].join('\n'));
  const msg = (id: string, from: string, to: string, date: string, text: string) =>
    [id, from, URL_OF(from.toLowerCase()), to, URL_OF(to.toLowerCase()), `2026-0${date} 10:00:00 UTC`, text, 'INBOX'].join(',');
  writeFileSync(
    join(dir, 'messages.csv'),
    ['CONVERSATION ID,FROM,SENDER PROFILE URL,TO,RECIPIENT PROFILE URLS,DATE,CONTENT,FOLDER',
      msg('c1', 'Olive', 'Tom', '1-02', 'hello'), msg('c1', 'Tom', 'Olive', '1-03', 'hi'),
      msg('c2', 'Pat', 'Olive', '2-01', 'Please book a call with me'),
      msg('c3', 'Olive', 'Gus', '3-01', 'one'), msg('c4', 'Olive', 'Gus', '3-02', 'two'), ''].join('\n'),
  );
  writeFileSync(join(dir, 'Endorsement_Received_Info.csv'), `Endorsement Date,Skill Name,Endorser First Name,Endorser Last Name,Endorser Public Url,Endorsement Status\n2025-01-01,Math,Eve,Endorser,${URL_OF('eve')},ACCEPTED\n`);
  writeFileSync(join(dir, 'Invitations.csv'), 'From,To,Sent At,Message,Direction\nOlive,Gus,"1/1/26, 1:00 AM",,OUTGOING\n');
  return dir;
}

function setup() {
  const config = liveConfig();
  const dir = tempDir();
  const keep = join(dir, 'keep.csv');
  writeFileSync(keep, `first_name,last_name,url\nKay,Keep,\n`);
  const overlay = join(dir, 'overlay.json');
  writeFileSync(overlay, JSON.stringify({ mission: ['fusion'], places: ['denver'], keep_files: [keep] }));
  const halt = join(dir, 'halt.txt');
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LINK_GAP: '0-0', LINK_RATER: overlay, LINK_HALT_FILE: halt };
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await call(config, undefined, name, args, env);
    return { isError: r.isError, text: r.content[0].text, json: r.isError ? undefined : JSON.parse(r.content[0].text) };
  };
  return { config, env, halt, tool };
}

test('archive_load rates a tiny export and writes connections.json at 600', async () => {
  const { config, tool } = setup();
  const out = (await tool('archive_load', { path: exportFolder() })).json;
  assert.equal(out.connections, 9);
  assert.deepEqual(out.by_reason, { pitch: 1, thread: 1, sales: 1, empty: 1, low: 1, new: 1, endorsed: 1, keeplist: 1, other: 1 });
  assert.deepEqual(out.by_tier, { REMOVE: 4, PROTECTED: 4, REVIEW: 1 });
  assert.equal(out.owner_found, true);
  assert.ok(out.from < out.to && /^\d{4}-\d\d-\d\d$/.test(out.from));
  assert.equal(statSync(join(config.home, 'connections.json')).mode & 0o777, 0o600);
  const quote = (await tool('connections_list', { reason: 'other' })).json.rows[0];
  assert.deepEqual([quote.position, quote.company], ['Line one\nLine two', 'Acme, Inc']);
  assert.equal((await tool('connections_list', { tier: 'REMOVE', limit: 2 })).json.rows.length, 2);
  assert.equal((await tool('connections_next')).json.reason, 'pitch');
});

test('archive_load reads a zip with /usr/bin/unzip into LINK_HOME/archive', { skip: !existsSync('/usr/bin/zip') || !existsSync('/usr/bin/unzip') }, async () => {
  const { config, tool } = setup();
  const folder = exportFolder();
  const zip = join(tempDir(), 'export.zip');
  execFileSync('/usr/bin/zip', ['-q', '-r', zip, '.'], { cwd: join(folder, '..') });
  assert.equal((await tool('archive_load', { path: zip })).json.connections, 9);
  assert.ok(existsSync(join(config.home, 'archive', 'Basic_LinkedInDataExport', 'Connections.csv')));
  assert.equal(statSync(join(config.home, 'archive')).mode & 0o777, 0o700);
});

test('a missing Connections.csv is a tool error', async () => {
  const { tool } = setup();
  const empty = tempDir();
  const r = await tool('archive_load', { path: empty });
  assert.equal(r.isError, true);
  assert.match(r.text, /no Connections\.csv/);
});

test('re-loading keeps marks and removed states, and next returns rows in reason order', async () => {
  const { tool } = setup();
  const folder = exportFolder();
  await tool('archive_load', { path: folder });
  await tool('connections_mark', { url: URL_OF('lou'), action: 'keep' });
  await tool('connections_mark', { url: URL_OF('pat'), action: 'removed' });
  assert.equal((await tool('connections_next')).json.reason, 'sales');
  await tool('archive_load', { path: folder });
  const rows = (await tool('connections_list', { limit: 100 })).json.rows;
  assert.equal(rows.find((r: { name: string }) => r.name === 'Lou Low').reason, 'override');
  assert.equal(rows.some((r: { name: string }) => r.name === 'Pat Pitch'), false);
  const unknown = await tool('connections_mark', { url: URL_OF('zed'), action: 'skipped' });
  assert.equal(unknown.isError, true);
});

test('connections_check: REMOVE only when the page agrees with the export', async () => {
  const { tool } = setup();
  await tool('archive_load', { path: exportFolder() });
  const page = { url: URL_OF('sam'), name: 'Sam Sales', degree: '1st', location: 'Austin, Texas', headline: 'Sales lead' };
  const verdict = async (over: Record<string, string>) => (await tool('connections_check', { ...page, ...over })).json;
  assert.deepEqual(await verdict({}), { verdict: 'REMOVE', reason: 'sales' });
  assert.match((await verdict({ name: 'Someone Else' })).reason, /name/);
  assert.match((await verdict({ degree: '2nd' })).reason, /1st/);
  assert.match((await verdict({ location: 'Denver, Colorado' })).reason, /rescue place/);
  assert.match((await verdict({ headline: 'Fusion researcher' })).reason, /mission/);
  assert.equal((await verdict({ url: URL_OF('pat'), name: 'Pat Pitch', headline: 'Fusion researcher' })).verdict, 'REMOVE');
  assert.match((await verdict({ url: URL_OF('tom'), name: 'Tom Thread' })).reason, /not in the REMOVE tier/);
  assert.match((await verdict({ url: URL_OF('zed') })).reason, /not in the loaded/);
});

const removed = (at: number, count: number) => Array.from({ length: count }, (_, i) => ({ time: new Date(at - i * 1000).toISOString(), url: `u${i}`, action: 'removed' }));

test('pace: the ramp by distinct days, the sitting cap, and a new sitting after 30 minutes idle', () => {
  const now = new Date('2026-11-13T12:00:00Z');
  const onDays = (n: number) => Array.from({ length: n }, (_, i) => ({ time: `2026-11-0${i + 1}T10:00:00Z`, url: 'u', action: 'removed' }));
  assert.deepEqual([0, 2, 3, 6, 7].map((n) => [pace(onDays(n), now).dailyCap, pace(onDays(n), now).sittingCap]), [[25, 25], [25, 25], [50, 25], [50, 25], [80, 40]]);
  const busy = pace(removed(now.getTime() - 60_000, 10), now);
  assert.equal(busy.doneSitting, 10);
  assert.equal(pace(removed(now.getTime() - 31 * 60_000, 10), now).doneSitting, 0);
  const warned = [...onDays(7), { time: '2026-11-08T10:00:00Z', url: '', action: 'warning' }];
  assert.equal(pace(warned, now).dailyCap, 25);
});

test('connections_next: daily cap, sitting cap, and the gap setting', async () => {
  const { config, tool } = setup();
  await tool('archive_load', { path: exportFolder() });
  const seed = (events: unknown[]) => writeFileSync(join(config.home, 'removals.json'), JSON.stringify(events));
  seed(removed(Date.now() - 60_000, 25));
  assert.match((await tool('connections_next')).text, /Daily cap/);
  const earlier = [1, 2, 3, 4].map((d) => ({ time: new Date(Date.now() - d * 86_400_000).toISOString(), url: 'u', action: 'removed' }));
  seed([...earlier, ...removed(Date.now() - 60_000, 25)]);
  assert.match((await tool('connections_next')).text, /Sitting cap/);
  seed([...earlier, ...removed(Date.now() - 40 * 60_000, 25)]);
  const next = await tool('connections_next');
  assert.equal(next.json.remaining_today, 25);
  assert.equal(next.json.url, URL_OF('pat'));
});

test('a warning writes the halt file and stops connections_next and post_publish', async () => {
  const { halt, tool } = setup();
  await tool('archive_load', { path: exportFolder() });
  assert.equal((await tool('connections_next')).isError, undefined);
  await tool('connections_mark', { url: URL_OF('pat'), action: 'warning', note: 'We noticed unusual activity' });
  assert.match(String(execFileSync('/bin/cat', [halt])), /unusual activity/);
  assert.match((await tool('connections_next')).text, /Halted/);
  assert.match((await tool('post_publish', { text: 'Hello' })).text, /Halted/);
});

test('with LINK_HALT_FILE unset the halt file is LINK_HOME/halt, and a warning stops next and post_publish', async () => {
  const { config, env, tool: withVar } = setup();
  const unset = { ...env, LINK_HALT_FILE: undefined };
  const tool = async (name: string, args: Record<string, unknown> = {}) => (await call(config, undefined, name, args, unset)).content[0].text;
  await withVar('archive_load', { path: exportFolder() });
  await tool('connections_mark', { url: URL_OF('pat'), action: 'warning', note: 'slow down' });
  assert.equal(statSync(join(config.home, 'halt')).mode & 0o777, 0o600);
  assert.match(await tool('connections_next'), /Halted/);
  assert.match(await tool('post_publish', { text: 'Hello' }), /Halted/);
});

test('a symlinked Connections.csv in the folder is ignored; a zip holding a symlink is refused', async () => {
  const { tool } = setup();
  const dir = tempDir();
  writeFileSync(join(tempDir(), 'real.csv'), 'x');
  symlinkSync(join(exportFolder(), 'Connections.csv'), join(dir, 'Connections.csv'));
  assert.match((await tool('archive_load', { path: dir })).text, /no Connections\.csv/);
  if (!existsSync('/usr/bin/zip') || !existsSync('/usr/bin/unzip')) return;
  const zip = join(tempDir(), 'link.zip');
  execFileSync('/usr/bin/zip', ['-q', '-y', zip, 'Connections.csv'], { cwd: dir });
  const r = await tool('archive_load', { path: zip });
  assert.equal(r.isError, true);
  assert.match(r.text, /symbolic link/);
});

test('a malformed LINK_GAP falls back to 15-45 instead of NaN', () => {
  assert.deepEqual([undefined, 'soon', '5', '1-', '2-4', '0-0'].map(gapRange), [[15, 45], [15, 45], [15, 45], [15, 45], [2, 4], [0, 0]]);
});

test('keep-list headers match with spaces or underscores, in any case', async () => {
  const keep = join(tempDir(), 'site.csv');
  writeFileSync(keep, '"Email","First Name","Last Name"\n,Kay,Keep\n');
  const overlay = join(tempDir(), 'o.json');
  writeFileSync(overlay, JSON.stringify({ keep_files: [keep] }));
  const rules = loadRules({ LINK_RATER: overlay });
  assert.equal(loadKeep(rules).names.has('kay keep'), true);
});
