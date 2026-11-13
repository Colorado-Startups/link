// SPDX-License-Identifier: Apache-2.0
// connections_list, connections_mark, connections_next, connections_check, and the halt file. None of them talks to
// LinkedIn: they read and write LINK_HOME/connections.json and removals.json (600). A person or an agent does the removing,
// one at a time, and reports back with connections_mark. connections_next paces it: a daily cap that ramps up, a sitting
// cap, a random gap since the last removal, and a stop while the halt file exists.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { connectionsFile, readConnections, writeJson, type Connection } from './archive.ts';
import { LinkError, type Config } from './linkedin.ts';
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

function events(config: Config): Event[] {
  try {
    return JSON.parse(readFileSync(removalsFile(config), 'utf8')) as Event[];
  } catch {
    return [];
  }
}

/** The halt file: LINK_HALT_FILE, or `halt` in LINK_HOME when it is unset. */
export const haltPath = (env: Env, config: Config): string => env.LINK_HALT_FILE || join(config.home, 'halt');

/** Throws while the halt file exists: every LinkedIn action stops until a person deletes it. */
export function refuseWhileHalted(env: Env, config: Config): void {
  const file = haltPath(env, config);
  if (existsSync(file)) throw new LinkError(`Halted: ${file} exists, written after a LinkedIn warning. Read it, wait, and delete it yourself to continue.`);
}

const name = (c: Connection) => `${c.first} ${c.last}`.trim();
const day = (iso: string) => iso.slice(0, 10);

export function connectionsList(input: { tier?: string; reason?: string; limit: number; offset: number }, config: Config) {
  const rows = readConnections(config).filter((c) => (!input.tier || c.tier === input.tier) && (!input.reason || c.reason === input.reason) && !c.state);
  return {
    total: rows.length,
    rows: rows.slice(input.offset, input.offset + input.limit).map((c) => ({
      name: name(c), position: c.position, company: c.company, connected_on: c.connected, tier: c.tier, reason: c.reason, url: c.url,
    })),
  };
}

export function connectionsMark(input: { url: string; action: string; note?: string }, config: Config, env: Env) {
  const time = new Date().toISOString();
  const url = normUrl(input.url);
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

/** The pace: day 1 to 3 since the last warning 25 a day, 4 to 7 50, 8 on 80; a sitting is 25, or 40 from day 8. */
export function pace(all: Event[], now: Date) {
  const warned = all.findLastIndex((e) => e.action === 'warning');
  const removed = all.slice(warned + 1).filter((e) => e.action === 'removed');
  const today = day(now.toISOString());
  const days = new Set(removed.map((e) => day(e.time)));
  days.add(today);
  const n = days.size;
  const sitting: Event[] = [];
  for (let at = now.getTime(), i = removed.length - 1; i >= 0 && at - Date.parse(removed[i].time) <= IDLE_MS; i--) {
    sitting.push(removed[i]);
    at = Date.parse(removed[i].time);
  }
  return {
    dailyCap: n <= 3 ? 25 : n <= 7 ? 50 : 80,
    sittingCap: n >= 8 ? 40 : 25,
    doneToday: removed.filter((e) => day(e.time) === today).length,
    doneSitting: sitting.length,
    lastRemoved: removed.at(-1)?.time,
  };
}

/** LINK_GAP as [min, max] seconds; anything that is not "min-max" gives the default 15-45. */
export const gapRange = (raw: string | undefined): number[] => (/^\d+(\.\d+)?-\d+(\.\d+)?$/.test(raw ?? '') ? raw! : '15-45').split('-').map(Number);

export async function connectionsNext(config: Config, env: Env) {
  refuseWhileHalted(env, config);
  const p = pace(events(config), new Date());
  if (p.doneToday >= p.dailyCap) throw new LinkError(`Daily cap reached: ${p.doneToday} of ${p.dailyCap} removed today. Continue tomorrow.`);
  if (p.doneSitting >= p.sittingCap) throw new LinkError(`Sitting cap reached: ${p.doneSitting} of ${p.sittingCap}. A new sitting starts after 30 minutes idle.`);
  const [lo, hi] = gapRange(env.LINK_GAP);
  const gap = (lo + Math.random() * (hi - lo)) * 1000 - (p.lastRemoved ? Date.now() - Date.parse(p.lastRemoved) : Infinity);
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

/** REMOVE or SKIP for one profile page, from what the page shows. The export has no location or headline. */
export function connectionsCheck(input: { url: string; name: string; degree: string; location: string; headline: string }, config: Config, env: Env) {
  const skip = (reason: string) => ({ verdict: 'SKIP', reason });
  const c = readConnections(config).find((r) => r.url === normUrl(input.url));
  if (!c) return skip('not in the loaded connections');
  if (c.tier !== 'REMOVE' || c.state) return skip(`not in the REMOVE tier (${c.state ?? c.tier})`);
  const page = plain(input.name);
  if (!page.includes(plain(c.first)) || !page.includes(plain(c.last))) return skip('name on the page differs from the export');
  if (!/^1(st)?\b/i.test(input.degree.trim())) return skip('not a 1st-degree connection');
  if (c.reason === 'override') return { verdict: 'REMOVE', reason: c.reason };
  const rules = loadRules(env);
  if (hasWord(input.location, rules.places)) return skip('rescue place in the location');
  if (['sales', 'empty', 'low'].includes(c.reason) && hasWord(input.headline, rules.mission)) return skip('mission words in the headline');
  return { verdict: 'REMOVE', reason: c.reason };
}
