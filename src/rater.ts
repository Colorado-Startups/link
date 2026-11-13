// SPDX-License-Identifier: Apache-2.0
// The connection rater: a pure function from one connection's export data and the rules to a tier and a reason.
// Eleven rules, the first match wins. No AI and no network: the rules are word lists and counts. The generic word
// lists ship in rules/rater.default.json; LINK_RATER names an optional overlay file merged on top (lists joined,
// other values replaced). Keep lists are CSV files named in `keep_files`, matched on url, email or first and last name.
import { readFileSync } from 'node:fs';
import { parseCsv } from './csv.ts';

export type Tier = 'PROTECTED' | 'KEEP' | 'REVIEW' | 'REMOVE';
/** The order connections_next removes in: the owner's own marks first, then the likeliest pitches. */
export const REASON_ORDER = ['override', 'pitch', 'sales', 'empty', 'low'];

export interface Rules {
  new_days: number;
  low_days: number;
  pitch: string[];
  sales: string[];
  mission: string[];
  places: string[];
  keep_files: string[];
}

/** What the export says about one connection. `connected` is YYYY-MM-DD or empty. */
export interface Row {
  first: string;
  last: string;
  url: string;
  email: string;
  company: string;
  position: string;
  connected: string;
  /** Messages the owner sent them in 1:1 threads, and received from them. */
  sent: number;
  received: number;
  /** The owner started a 1:1 thread with them. */
  started: boolean;
  /** An endorsement or recommendation either way. */
  endorsed: boolean;
  /** They wrote first, with a pitch phrase. */
  pitchFirst: boolean;
  /** On a keep list. */
  keep: boolean;
  /** The owner's override from connections_mark. */
  mark?: 'keep' | 'remove';
}

export interface Rating {
  tier: Tier;
  reason: string;
}

/** The URL as a key: lower case, no query, no trailing slash. */
export const normUrl = (url: string): string => url.trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');

/** True when `text` holds any of `words` as whole words or phrases, ignoring case. */
export function hasWord(text: string, words: string[]): boolean {
  const low = text.toLowerCase();
  return words.some((word) => {
    const w = word.toLowerCase();
    for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + 1)) {
      if (!/[a-z0-9]/.test(low[i - 1] ?? ' ') && !/[a-z0-9]/.test(low[i + w.length] ?? ' ')) return true;
    }
    return false;
  });
}

const DEFAULT = new URL('../rules/rater.default.json', import.meta.url);

/** The default rules with the LINK_RATER overlay, when `env` names one, merged on top. */
export function loadRules(env: Record<string, string | undefined>): Rules {
  const rules = JSON.parse(readFileSync(DEFAULT, 'utf8')) as Rules;
  if (!env.LINK_RATER) return rules;
  const overlay = JSON.parse(readFileSync(env.LINK_RATER, 'utf8')) as Record<string, unknown>;
  for (const [key, value] of Object.entries(overlay)) {
    const old = (rules as unknown as Record<string, unknown>)[key];
    (rules as unknown as Record<string, unknown>)[key] = Array.isArray(old) && Array.isArray(value) ? [...old, ...value] : value;
  }
  return rules;
}

/** The keep lists: urls, emails and "first last" names from every file in `keep_files`. */
export function loadKeep(rules: Rules): { urls: Set<string>; emails: Set<string>; names: Set<string> } {
  const keep = { urls: new Set<string>(), emails: new Set<string>(), names: new Set<string>() };
  for (const file of rules.keep_files) {
    const [head = [], ...rows] = parseCsv(readFileSync(file, 'utf8'));
    const col = (name: string) => head.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_')).indexOf(name);
    const [u, e, f, l] = [col('url'), col('email'), col('first_name'), col('last_name')];
    for (const r of rows) {
      if (u >= 0 && r[u]) keep.urls.add(normUrl(r[u]));
      if (e >= 0 && r[e]) keep.emails.add(r[e].trim().toLowerCase());
      if (f >= 0 && l >= 0 && r[f] && r[l]) keep.names.add(`${r[f]} ${r[l]}`.trim().toLowerCase());
    }
  }
  return keep;
}

/** Rates one connection at time `now`. */
export function rate(row: Row, rules: Rules, now: Date): Rating {
  const days = row.connected ? (now.getTime() - Date.parse(`${row.connected}T00:00:00Z`)) / 86_400_000 : Infinity;
  const place = (text: string) => hasWord(text, [...rules.mission, ...rules.places]);
  const rated = (tier: Tier, reason: string): Rating => ({ tier, reason });
  if (row.mark) return row.mark === 'keep' ? rated('KEEP', 'override') : rated('REMOVE', 'override'); // 1
  if (row.started || row.sent >= 2) return rated('PROTECTED', 'thread'); // 2
  if (row.endorsed) return rated('PROTECTED', 'endorsed'); // 3
  if (row.keep) return rated('PROTECTED', 'keeplist'); // 4
  if (days <= rules.new_days && !row.pitchFirst) return rated('PROTECTED', 'new'); // 5
  if (row.pitchFirst && row.sent === 0) return rated('REMOVE', 'pitch'); // 6
  if (hasWord(row.position, rules.sales)) return rated('REMOVE', 'sales'); // 7
  if (place(`${row.position} ${row.company}`)) return rated('KEEP', 'mission'); // 8
  if (!row.position.trim() && !row.company.trim()) return rated('REMOVE', 'empty'); // 9
  if (row.sent + row.received === 0 && days > rules.low_days) return rated('REMOVE', 'low'); // 10
  return rated('REVIEW', 'other'); // 11
}
