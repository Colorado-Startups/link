// SPDX-License-Identifier: Apache-2.0
// The connection rater: a pure function from one connection's export data and the rules to a tier and a reason.
// Eleven rules, the first match wins. No AI and no network: the rules are word lists and counts. The generic word
// lists ship in rules/rater.default.json; LINK_RATER names an optional overlay file merged on top (lists joined,
// other values replaced). Keep lists are CSV files named in `keep_files`, matched on url, email or first and last name.
import { readFileSync } from 'node:fs';
import { parseCsv } from './csv.ts';

type Tier = 'PROTECTED' | 'KEEP' | 'REVIEW' | 'REMOVE';
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

/** The keep lists: profile URLs, emails and lower-case "first last" names. */
export interface Keep {
  urls: Set<string>;
  emails: Set<string>;
  names: Set<string>;
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

/** One cell of a row, or '' when the column is missing (index below 0) or the row is short. */
const cellAt = (row: string[], index: number): string => (index >= 0 ? (row[index] ?? '') : '');

/** Adds the urls, emails and "first last" names of one keep file's CSV text to `keep`. */
function addKeepRows(keep: Keep, text: string): void {
  const [head = [], ...rows] = parseCsv(text);
  const col = (name: string) => head.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_')).indexOf(name);
  const [u, e, f, l] = [col('url'), col('email'), col('first_name'), col('last_name')];
  for (const r of rows) {
    if (cellAt(r, u)) keep.urls.add(normUrl(r[u]));
    if (cellAt(r, e)) keep.emails.add(r[e].trim().toLowerCase());
    if (cellAt(r, f) && cellAt(r, l)) keep.names.add(`${r[f]} ${r[l]}`.trim().toLowerCase());
  }
}

/** The keep lists: urls, emails and "first last" names from every file in `keep_files`. */
export function loadKeep(rules: Rules): Keep {
  const keep: Keep = { urls: new Set(), emails: new Set(), names: new Set() };
  for (const file of rules.keep_files) addKeepRows(keep, readFileSync(file, 'utf8'));
  return keep;
}

type Rule = (row: Row, rules: Rules, days: number) => Rating | undefined;

/** A rule that gives `tier` and `reason` when `test` holds, and no verdict otherwise. */
const when =
  (test: (row: Row, rules: Rules, days: number) => boolean, tier: Tier, reason: string): Rule =>
  (row, rules, days) =>
    test(row, rules, days) ? { tier, reason } : undefined;

/** The rules in order, the first match wins; REVIEW 'other' is the answer when none matches. */
const RULES: Rule[] = [
  when((row) => row.mark === 'keep', 'KEEP', 'override'), // 1
  when((row) => row.mark === 'remove', 'REMOVE', 'override'), // 1
  when((row) => row.started || row.sent >= 2, 'PROTECTED', 'thread'), // 2
  when((row) => row.endorsed, 'PROTECTED', 'endorsed'), // 3
  when((row) => row.keep, 'PROTECTED', 'keeplist'), // 4
  when((row, rules, days) => days <= rules.new_days && !row.pitchFirst, 'PROTECTED', 'new'), // 5
  when((row) => row.pitchFirst && row.sent === 0, 'REMOVE', 'pitch'), // 6
  when((row, rules) => hasWord(row.position, rules.sales), 'REMOVE', 'sales'), // 7
  when((row, rules) => hasWord(`${row.position} ${row.company}`, [...rules.mission, ...rules.places]), 'KEEP', 'mission'), // 8
  when((row) => !row.position.trim() && !row.company.trim(), 'REMOVE', 'empty'), // 9
  when((row, rules, days) => row.sent + row.received === 0 && days > rules.low_days, 'REMOVE', 'low'), // 10
];

/** Rates one connection at time `now`. */
export function rate(row: Row, rules: Rules, now: Date): Rating {
  const days = row.connected ? (now.getTime() - Date.parse(`${row.connected}T00:00:00Z`)) / 86_400_000 : Infinity;
  for (const rule of RULES) {
    const rating = rule(row, rules, days);
    if (rating) return rating;
  }
  return { tier: 'REVIEW', reason: 'other' }; // 11
}
