// SPDX-License-Identifier: Apache-2.0
// archive_load: reads a LinkedIn data export (the .zip or the unpacked folder) once, rates every connection and writes
// LINK_HOME/connections.json (600). It reads local files only. A re-load keeps the owner's marks and states by URL.
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseCsv, records } from './csv.ts';
import { childEnv, LinkError, type Config } from './linkedin.ts';
import { hasWord, loadKeep, loadRules, normUrl, rate, type Row } from './rater.ts';

type Env = Record<string, string | undefined>;

/** One stored connection: the export's fields, its signals, the owner's mark and state, and its tier and reason. */
export interface Connection extends Row {
  state?: 'removed' | 'skipped';
  note?: string;
  tier: string;
  reason: string;
}

export const connectionsFile = (config: Config) => join(config.home, 'connections.json');

export function readConnections(config: Config): Connection[] {
  try {
    return JSON.parse(readFileSync(connectionsFile(config), 'utf8')) as Connection[];
  } catch {
    throw new LinkError('No connections loaded yet. Run archive_load with the path to your LinkedIn data export first.');
  }
}

/** Writes JSON for the owner only (600). */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  chmodSync(path, 0o600);
}

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

export async function archiveLoad(input: { path: string }, config: Config, env: Env): Promise<Record<string, unknown>> {
  if (!existsSync(input.path)) throw new LinkError(`Nothing at ${input.path}. Give the path to the export .zip or its unpacked folder.`);
  let dir = input.path;
  if (statSync(input.path).isFile()) {
    dir = join(config.home, 'archive');
    mkdirSync(config.home, { recursive: true, mode: 0o700 });
    const listing = await unzip(['-Z', input.path], env);
    if (/^l/m.test(listing)) throw new LinkError('The zip holds a symbolic link. Link will not unpack it. Request a fresh export from LinkedIn.');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { mode: 0o700 });
    await unzip(['-o', '-q', input.path, '-d', dir], env);
  }
  const files = walk(dir);
  const table = (name: string, anchor: string) => (files.has(name) ? records(readFileSync(files.get(name)!, 'utf8'), anchor) : []);
  const rules = loadRules(env);
  const keep = loadKeep(rules);
  if (!files.has('connections.csv')) throw new LinkError('The export has no Connections.csv. Request the full archive, or select Connections when you request it.');
  const people = table('connections.csv', 'first name');

  // Messages: who the owner is (the most frequent sender, or LINK_OWNER_URL), then per person what was sent and received.
  const messages = table('messages.csv', 'conversation id');
  const keyOf = (m: Record<string, string>) => normUrl(m['sender profile url'] ?? '') || (m.from ?? '').toLowerCase();
  const counts = new Map<string, number>();
  for (const m of messages) counts.set(keyOf(m), (counts.get(keyOf(m)) ?? 0) + 1);
  const owner = env.LINK_OWNER_URL ? normUrl(env.LINK_OWNER_URL) : ([...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '');
  const sig = new Map<string, { sent: number; received: number; started: boolean; pitchFirst: boolean }>();
  const of = (url: string) => sig.get(url) ?? (sig.set(url, { sent: 0, received: 0, started: false, pitchFirst: false }), sig.get(url)!);
  const threads = new Map<string, Record<string, string>[]>();
  for (const m of messages) threads.set(m['conversation id'], [...(threads.get(m['conversation id']) ?? []), m]);
  const dates: string[] = [];
  for (const thread of threads.values()) {
    thread.sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || 0);
    thread.forEach((m, i) => {
      dates.push(isoDate(m.date));
      const to = (m['recipient profile urls'] ?? '').split(',').map(normUrl).filter(Boolean);
      if (to.length !== 1) return; // a group thread is not a relationship signal
      if (keyOf(m) === owner) {
        of(to[0]).sent++;
        if (i === 0) of(to[0]).started = true;
      } else {
        const them = of(keyOf(m));
        them.received++;
        if (i === 0 && hasWord(m.content ?? '', rules.pitch)) them.pitchFirst = true;
      }
    });
  }

  // Endorsements and recommendations, either way: any profile URL in those files, and names from first/last columns.
  const endorsed = new Set<string>();
  for (const [name, path] of files) {
    if (!/endorsement|recommendation/.test(name) || !name.endsWith('.csv')) continue;
    const text = readFileSync(path, 'utf8');
    for (const m of text.matchAll(/https?:\/\/[^\s",]*linkedin\.com\/in\/[^\s",]+/gi)) endorsed.add(normUrl(m[0]));
    const rows = parseCsv(text);
    const head = (rows.find((r) => r.some((c) => /first name/i.test(c))) ?? []).map((h) => h.trim().toLowerCase());
    for (const r of rows.slice(rows.findIndex((x) => x.some((c) => /first name/i.test(c))) + 1)) {
      head.forEach((h, i) => {
        const last = head.indexOf(h.replace('first name', 'last name'));
        if (h.endsWith('first name') && last >= 0 && r[i] && r[last]) endorsed.add(`${r[i]} ${r[last]}`.trim().toLowerCase());
      });
    }
  }
  const prior = new Map<string, Connection>();
  try {
    for (const c of readConnections(config)) prior.set(c.url, c);
  } catch {
    // a first load
  }
  const now = new Date();
  const out: Connection[] = people.map((p) => {
    const url = normUrl(p.url ?? '');
    const s = sig.get(url);
    const was = prior.get(url);
    const first = p['first name'] ?? '';
    const last = p['last name'] ?? '';
    const email = (p['email address'] ?? '').toLowerCase();
    const row: Row = {
      first, last, url, email, company: p.company ?? '', position: p.position ?? '', connected: isoDate(p['connected on'] ?? ''),
      sent: s?.sent ?? 0, received: s?.received ?? 0, started: s?.started ?? false, pitchFirst: s?.pitchFirst ?? false,
      endorsed: endorsed.has(url) || endorsed.has(`${first} ${last}`.trim().toLowerCase()),
      keep: keep.urls.has(url) || (email !== '' && keep.emails.has(email)) || keep.names.has(`${first} ${last}`.trim().toLowerCase()),
      mark: was?.mark,
    };
    return { ...row, state: was?.state, note: was?.note, ...rate(row, rules, now) };
  });
  writeJson(connectionsFile(config), out);
  const tally = (key: 'tier' | 'reason') => out.reduce<Record<string, number>>((n, c) => ((n[c[key]] = (n[c[key]] ?? 0) + 1), n), {});
  dates.push(...out.map((c) => c.connected));
  const seen = dates.filter(Boolean).sort();
  return { connections: out.length, by_tier: tally('tier'), by_reason: tally('reason'), from: seen[0] ?? null, to: seen.at(-1) ?? null, owner_found: owner !== '' };
}
