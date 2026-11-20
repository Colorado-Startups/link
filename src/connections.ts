// SPDX-License-Identifier: Apache-2.0
// connections_list, connections_mark, connections_next, connections_check, and the halt file. None of them talks to
// LinkedIn: they read and write LINKEN_HOME/connections.json and removals.json (600). A person or an agent does the removing,
// one at a time, and reports back with connections_mark. connections_next paces it: a daily cap that ramps up, a sitting
// cap, a random gap since the last removal or skip, and a stop while the halt file exists.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LinkError, type Config } from './core.ts';
import { connectionsFile, readConnections, readJson, writeJson, type Connection } from './store.ts';
import { hasWord, loadRules, normUrl, REASON_ORDER } from './rater.ts';

type Env = Record<string, string | undefined>;
interface Event {
  time: string;
  url: string;
  action: string;
  note?: string;
}

const removalsFile = (config: Config) => join(config.home, 'removals.json');
const IDLE_MS = 30 * 60_000;

const events = (config: Config): Event[] => readJson<Event[]>(removalsFile(config), () => []);

/** The halt file: LINKEN_HALT_FILE, or `halt` in LINKEN_HOME when it is unset. */
const haltPath = (env: Env, config: Config): string => env.LINKEN_HALT_FILE || join(config.home, 'halt');

/** Throws while the halt file exists: every LinkedIn action stops until a person deletes it. */
export function refuseWhileHalted(env: Env, config: Config): void {
  const file = haltPath(env, config);
  if (existsSync(file)) throw new LinkError(`Halted: ${file} exists, written after a LinkedIn warning. Read it, wait, and delete it yourself to continue.`);
}

const name = (c: Connection) => `${c.first} ${c.last}`.trim();
/** The LOCAL calendar date (YYYY-MM-DD) of a time, so a day ends at the owner's midnight, not at UTC midnight. */
const day = (time: string | Date) => {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** One page of the loaded connections that have no state, optionally only one tier or one reason. */
export function connectionsList(input: { tier?: string; reason?: string; limit: number; offset: number }, config: Config) {
  const rows = readConnections(config).filter((c) => (!input.tier || c.tier === input.tier) && (!input.reason || c.reason === input.reason) && !c.state);
  return {
    total: rows.length,
    rows: rows.slice(input.offset, input.offset + input.limit).map((c) => ({
      name: name(c), position: c.position, company: c.company, connected_on: c.connected, tier: c.tier, reason: c.reason, url: c.url,
    })),
  };
}

/** Records the owner's decision for one connection; a warning also writes the halt file. */
export function connectionsMark(input: { url: string; action: string; note?: string }, config: Config, env: Env) {
  const time = new Date().toISOString();
  const url = normUrl(input.url);
  if (!url && input.action !== 'warning') throw new LinkError('connections_mark needs a profile URL.');
  const all = events(config);
  all.push({ time, url, action: input.action, ...(input.note ? { note: input.note } : {}) });
  if (input.action === 'warning') {
    const file = haltPath(env, config);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${time}\n${input.note ?? 'LinkedIn warning'}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  } else {
    const rows = readConnections(config);
    const c = rows.find((r) => r.url === url);
    if (!c) throw new LinkError(`${input.url} is not in the loaded connections.`);
    if (input.action === 'keep') Object.assign(c, { mark: 'keep', tier: 'KEEP', reason: 'override', state: undefined });
    else if (input.action === 'remove') Object.assign(c, { mark: 'remove', tier: 'REMOVE', reason: 'override', state: undefined });
    else c.state = input.action as 'removed' | 'skipped';
    if (input.note) c.note = input.note;
    writeJson(connectionsFile(config), rows);
  }
  writeJson(removalsFile(config), all);
  return { marked: input.action, url, halted: input.action === 'warning' };
}

/** A cap from the environment may only lower the built-in one; a higher, zero or malformed value is ignored. */
const lowered = (raw: string | undefined, builtin: number): number => (/^[1-9]\d*$/.test(raw ?? '') ? Math.min(builtin, Number(raw)) : builtin);

/** The pace: day 1 to 3 since the last warning 25 a day, 4 to 7 50, 8 on 80; a sitting is 25, or 40 from day 8. */
export function pace(all: Event[], now: Date, env: Env = {}) {
  const warned = all.findLastIndex((e) => e.action === 'warning');
  const since = all.slice(warned + 1);
  const removed = since.filter((e) => e.action === 'removed');
  const today = day(now);
  const days = new Set(removed.map((e) => day(e.time)));
  days.add(today);
  const n = days.size;
  const sitting: Event[] = [];
  for (let at = now.getTime(), i = removed.length - 1; i >= 0 && at - Date.parse(removed[i].time) <= IDLE_MS; i--) {
    sitting.push(removed[i]);
    at = Date.parse(removed[i].time);
  }
  return {
    dailyCap: lowered(env.LINKEN_DAILY_CAP, n <= 3 ? 25 : n <= 7 ? 50 : 80),
    sittingCap: lowered(env.LINKEN_SITTING_CAP, n >= 8 ? 40 : 25),
    doneToday: removed.filter((e) => day(e.time) === today).length,
    doneSitting: sitting.length,
    lastActed: since.findLast((e) => e.action === 'removed' || e.action === 'skipped')?.time,
  };
}

/** LINKEN_GAP as [min, max] seconds; anything that is not "min-max" gives the default 15-45. */
export const gapRange = (raw: string | undefined): number[] => (/^\d+(\.\d+)?-\d+(\.\d+)?$/.test(raw ?? '') ? raw! : '15-45').split('-').map(Number);

/** The next connection to remove, in REASON_ORDER, after the halt, daily, sitting and gap checks. */
export async function connectionsNext(config: Config, env: Env) {
  refuseWhileHalted(env, config);
  const p = pace(events(config), new Date(), env);
  if (p.doneToday >= p.dailyCap) throw new LinkError(`Daily cap reached: ${p.doneToday} of ${p.dailyCap} removed today. Continue tomorrow.`);
  if (p.doneSitting >= p.sittingCap) throw new LinkError(`Sitting cap reached: ${p.doneSitting} of ${p.sittingCap}. A new sitting starts after 30 minutes idle.`);
  const [lo, hi] = gapRange(env.LINKEN_GAP);
  const gap = (lo + Math.random() * (hi - lo)) * 1000 - (p.lastActed ? Date.now() - Date.parse(p.lastActed) : Infinity);
  if (gap > 0) await new Promise((done) => setTimeout(done, gap));
  const rows = readConnections(config).filter((c) => c.tier === 'REMOVE' && !c.state && c.url);
  for (const reason of REASON_ORDER) {
    const c = rows.find((r) => r.reason === reason);
    if (c) {
      return { name: name(c), position: c.position, company: c.company, connected_on: c.connected, reason: c.reason, url: c.url, remaining_today: p.dailyCap - p.doneToday };
    }
  }
  return { done: true, remaining_today: p.dailyCap - p.doneToday };
}

const plain = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim();

type Page = { url: string; name: string; degree?: string; location?: string; headline: string };

/** Why the page is not this connection's profile (its name, or a degree other than 1st when one is given), or undefined when it is. */
function notThisProfile(c: Connection, page: Page): string | undefined {
  const shown = plain(page.name);
  if (!shown.includes(plain(c.first)) || !shown.includes(plain(c.last))) return 'name on the page differs from the export';
  if (page.degree !== undefined && !/^1(st)?\b/i.test(page.degree.trim())) return 'not a 1st-degree connection';
  return undefined;
}

/** Why the page's location or headline rescues the connection from removal, or undefined when nothing does. */
function rescuedBy(c: Connection, page: Page, env: Env): string | undefined {
  const rules = loadRules(env);
  if (hasWord(page.location ?? '', rules.places)) return 'rescue place in the location';
  if (['sales', 'empty', 'low'].includes(c.reason) && hasWord(page.headline, rules.mission)) return 'mission words in the headline';
  return undefined;
}

/** REMOVE or SKIP for one page against its stored connection (undefined when the URL is not loaded). */
function verdictFor(c: Connection | undefined, page: Page, env: Env) {
  const skip = (reason: string) => ({ verdict: 'SKIP', reason });
  if (!c) return skip('not in the loaded connections');
  if (c.tier !== 'REMOVE' || c.state) return skip(`not in the REMOVE tier (${c.state ?? c.tier})`);
  const mismatch = notThisProfile(c, page);
  if (mismatch) return skip(mismatch);
  const rescue = rescuedBy(c, page, env);
  if (rescue) return skip(rescue);
  return { verdict: 'REMOVE', reason: c.reason };
}

/** REMOVE or SKIP for one profile page, from what the page shows. The export has no location or headline. */
export function connectionsCheck(input: Page, config: Config, env: Env) {
  return verdictFor(readConnections(config).find((r) => r.url === normUrl(input.url)), input, env);
}

/** One verdict per row of one screen of the Connections list. List rows are 1st degree by definition, and a missing location is allowed. Records nothing. */
export function connectionsCheckList(input: { rows: Omit<Page, 'degree'>[] }, config: Config, env: Env) {
  const all = readConnections(config);
  return { verdicts: input.rows.map((r) => ({ url: r.url, ...verdictFor(all.find((c) => c.url === normUrl(r.url)), r, env) })) };
}

const countOf = (values: string[]) => values.reduce<Record<string, number>>((n, v) => ((n[v] = (n[v] ?? 0) + 1), n), {});

/** The state of the clean-up in one call: counts, the queue, today's and this sitting's progress against the caps, and the last warning. */
export function connectionsSummary(config: Config, env: Env) {
  const rows = readConnections(config);
  const all = events(config);
  const p = pace(all, new Date(), env);
  const warning = all.findLast((e) => e.action === 'warning')?.time;
  const days = (iso: string) => Math.round((Date.parse(`${day(new Date())}T00:00:00Z`) - Date.parse(`${day(iso)}T00:00:00Z`)) / 86_400_000);
  return {
    by_tier: countOf(rows.map((c) => c.tier)),
    by_reason: countOf(rows.map((c) => c.reason)),
    by_state: countOf(rows.flatMap((c) => (c.state ? [c.state] : []))),
    queue: rows.filter((c) => c.tier === 'REMOVE' && c.url && !c.state).length,
    today: { done: p.doneToday, cap: p.dailyCap },
    sitting: { done: p.doneSitting, cap: p.sittingCap },
    last_removed: all.findLast((e) => e.action === 'removed')?.time ?? null,
    last_warning: warning ?? null,
    days_since_warning: warning ? days(warning) : null,
    halted: existsSync(haltPath(env, config)),
  };
}
