// SPDX-License-Identifier: Apache-2.0
// archive_load: reads a LinkedIn data export (the .zip or the unpacked folder) once, rates every connection and writes
// LINK_HOME/connections.json and inbox.json (600). It reads local files only. A re-load keeps the owner's marks and states by URL.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv, records } from './csv.ts';
import { waitingThreads, writeInbox } from './inbox.ts';
import { childEnv, LinkError, type Config } from './core.ts';
import { hasWord, loadKeep, loadRules, normUrl, rate, type Keep, type Row, type Rules } from './rater.ts';
import { connectionsFile, readConnections, writeJson, type Connection } from './store.ts';

type Env = Record<string, string | undefined>;

/** YYYY-MM-DD of a date as the export writes it ("13 Nov 2026" or "2026-11-13 10:00:00 UTC"), or ''. */
function isoDate(text: string): string {
  const t = Date.parse(/utc|z$|t/i.test(text) ? text : `${text} UTC`);
  return Number.isNaN(t) ? '' : new Date(t).toISOString().slice(0, 10);
}

/** Every file under `dir`, keyed by lower-cased base name; the first found wins. */
function walk(dir: string, found: Map<string, string> = new Map()): Map<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(path, found);
    else if (!found.has(entry.name.toLowerCase())) found.set(entry.name.toLowerCase(), path);
  }
  return found;
}

/** Runs /usr/bin/unzip with `args` and returns its output. */
const unzip = (args: string[], env: Env) => new Promise<string>((done, fail) => execFile('/usr/bin/unzip', args, { env: childEnv(env) }, (e, out) => (e ? fail(new LinkError(`unzip could not read ${args.at(-1)}.`)) : done(out))));

type Message = Record<string, string>;
/** What the messages say about one person: how many each way, who started the thread, and whether they opened with a pitch. */
type Signals = { sent: number; received: number; started: boolean; pitchFirst: boolean };

/** Everything the rating of one connection reads besides its own row. */
interface Context {
  rules: Rules;
  keep: Keep;
  signals: Map<string, Signals>;
  endorsed: Set<string>;
  prior: Map<string, Connection>;
  now: Date;
}

/** The person a message is from: its sender's profile URL, or the name in `from`. */
const keyOf = (m: Message) => normUrl(m['sender profile url'] ?? '') || (m.from ?? '').toLowerCase();

/** The folder that holds the export: `path` itself, or LINK_HOME/archive with the zip unpacked into it. */
async function exportDir(path: string, config: Config, env: Env): Promise<string> {
  if (!existsSync(path)) throw new LinkError(`Nothing at ${path}. Give the path to the export .zip or its unpacked folder.`);
  if (!statSync(path).isFile()) return path;
  const dir = join(config.home, 'archive');
  mkdirSync(config.home, { recursive: true, mode: 0o700 });
  const listing = await unzip(['-Z', path], env);
  if (/^l/m.test(listing)) throw new LinkError('The zip holds a symbolic link. Link will not unpack it. Request a fresh export from LinkedIn.');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { mode: 0o700 });
  await unzip(['-o', '-q', path, '-d', dir], env);
  return dir;
}

/** Who the owner is: LINK_OWNER_URL, or the most frequent sender in the messages. */
function ownerOf(messages: Message[], env: Env): string {
  if (env.LINK_OWNER_URL) return normUrl(env.LINK_OWNER_URL);
  const counts = new Map<string, number>();
  for (const m of messages) counts.set(keyOf(m), (counts.get(keyOf(m)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

/** The messages by conversation id, each thread oldest first. */
function groupThreads(messages: Message[]): Map<string, Message[]> {
  const threads = new Map<string, Message[]>();
  for (const m of messages) threads.set(m['conversation id'], [...(threads.get(m['conversation id']) ?? []), m]);
  for (const thread of threads.values()) thread.sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || 0);
  return threads;
}

/** The signals of `url`, added when there are none yet. */
function signalsOf(signals: Map<string, Signals>, url: string): Signals {
  const known = signals.get(url);
  if (known) return known;
  const fresh = { sent: 0, received: 0, started: false, pitchFirst: false };
  signals.set(url, fresh);
  return fresh;
}

/** Counts one message into `signals`; `first` is true for the first message of its thread. */
function countMessage(signals: Map<string, Signals>, m: Message, first: boolean, owner: string, rules: Rules): void {
  const to = (m['recipient profile urls'] ?? '').split(',').map(normUrl).filter(Boolean);
  if (to.length !== 1) return; // a group thread is not a relationship signal
  if (keyOf(m) === owner) {
    const mine = signalsOf(signals, to[0]);
    mine.sent++;
    if (first) mine.started = true;
    return;
  }
  const them = signalsOf(signals, keyOf(m));
  them.received++;
  if (first && hasWord(m.content ?? '', rules.pitch)) them.pitchFirst = true;
}

/** Per person what was sent and received, and the date of every message. */
function messageSignals(threads: Map<string, Message[]>, owner: string, rules: Rules) {
  const signals = new Map<string, Signals>();
  const dates: string[] = [];
  for (const thread of threads.values()) {
    thread.forEach((m, i) => {
      dates.push(isoDate(m.date));
      countMessage(signals, m, i === 0, owner, rules);
    });
  }
  return { signals, dates };
}

/** The "first last" names (lower case) a recommendation or endorsement CSV lists, from its first and last name columns. */
function namesIn(rows: string[][]): string[] {
  const at = rows.findIndex((r) => r.some((c) => /first name/i.test(c)));
  const head = (rows[at] ?? []).map((h) => h.trim().toLowerCase());
  const names: string[] = [];
  for (const r of rows.slice(at + 1)) {
    head.forEach((h, i) => {
      const last = head.indexOf(h.replace('first name', 'last name'));
      if (h.endsWith('first name') && last >= 0 && r[i] && r[last]) names.push(`${r[i]} ${r[last]}`.trim().toLowerCase());
    });
  }
  return names;
}

/** Endorsements and recommendations, either way: any profile URL in those files, and names from first/last columns. */
function endorsedIn(files: Map<string, string>): Set<string> {
  const endorsed = new Set<string>();
  for (const [name, path] of files) {
    if (!/endorsement|recommendation/.test(name) || !name.endsWith('.csv')) continue;
    const text = readFileSync(path, 'utf8');
    for (const m of text.matchAll(/https?:\/\/[^\s",]*linkedin\.com\/in\/[^\s",]+/gi)) endorsed.add(normUrl(m[0]));
    for (const person of namesIn(parseCsv(text))) endorsed.add(person);
  }
  return endorsed;
}

/** The connections of an earlier load by URL, so a re-load keeps the owner's marks and states; none on a first load. */
function priorConnections(config: Config): Map<string, Connection> {
  const prior = new Map<string, Connection>();
  try {
    for (const c of readConnections(config)) prior.set(c.url, c);
  } catch {
    // a first load
  }
  return prior;
}

/** One export row as a stored connection: its signals, its earlier mark and state, and its rating. */
function connectionOf(p: Record<string, string>, x: Context): Connection {
  const cell = (key: string) => p[key] ?? '';
  const url = normUrl(cell('url'));
  const s = x.signals.get(url) ?? { sent: 0, received: 0, started: false, pitchFirst: false };
  const was = x.prior.get(url);
  const [first, last, email] = [cell('first name'), cell('last name'), cell('email address').toLowerCase()];
  const full = `${first} ${last}`.trim().toLowerCase();
  const row: Row = {
    first, last, url, email, company: cell('company'), position: cell('position'), connected: isoDate(cell('connected on')),
    sent: s.sent, received: s.received, started: s.started, pitchFirst: s.pitchFirst,
    endorsed: x.endorsed.has(url) || x.endorsed.has(full),
    keep: x.keep.urls.has(url) || (email !== '' && x.keep.emails.has(email)) || x.keep.names.has(full),
    mark: was?.mark,
  };
  return { ...row, state: was?.state, note: was?.note, ...rate(row, x.rules, x.now) };
}

/** How many of `rows` have each value of `key`. */
const countBy = (rows: Connection[], key: 'tier' | 'reason') => rows.reduce<Record<string, number>>((n, c) => ((n[c[key]] = (n[c[key]] ?? 0) + 1), n), {});

/**
 * Reads the export at `input.path` once: rates every connection, stores them in connections.json and the waiting
 * message threads in inbox.json, and returns the counts by tier and reason and the export's date range.
 */
export async function archiveLoad(input: { path: string }, config: Config, env: Env): Promise<Record<string, unknown>> {
  const files = walk(await exportDir(input.path, config, env));
  const table = (name: string, anchor: string) => (files.has(name) ? records(readFileSync(files.get(name)!, 'utf8'), anchor) : []);
  const rules = loadRules(env);
  const keep = loadKeep(rules);
  if (!files.has('connections.csv')) throw new LinkError('The export has no Connections.csv. Request the full archive, or select Connections when you request it.');
  const people = table('connections.csv', 'first name');

  // Messages: who the owner is (the most frequent sender, or LINK_OWNER_URL), then per person what was sent and received.
  const messages = table('messages.csv', 'conversation id');
  const owner = ownerOf(messages, env);
  const threads = groupThreads(messages);
  const { signals, dates } = messageSignals(threads, owner, rules);
  const inbox = waitingThreads(threads, (m) => keyOf(m) === owner);
  writeInbox(config, inbox);

  const context = { rules, keep, signals, endorsed: endorsedIn(files), prior: priorConnections(config), now: new Date() };
  const out = people.map((p) => connectionOf(p, context));
  writeJson(connectionsFile(config), out);
  dates.push(...out.map((c) => c.connected));
  const seen = dates.filter(Boolean).sort();
  return { connections: out.length, by_tier: countBy(out, 'tier'), by_reason: countBy(out, 'reason'), from: seen[0] ?? null, to: seen.at(-1) ?? null, owner_found: owner !== '', inbox_waiting: inbox.length };
}
