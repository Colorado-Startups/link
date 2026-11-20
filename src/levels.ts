// SPDX-License-Identifier: Apache-2.0
// Levels on top of the rater's tiers, and the live proof a profile page must give before anything is removed.
// The goal is to keep every contact that matters and remove only clear spam, bare profiles and, when the member opts in,
// people who still sell. The export can be years old, so a level is never enough on its own: the page decides.
// docs/decide.md draws both tables.
import { hasWord, type Rating, type Row, type Rules } from './rater.ts';

export type Level = 'core' | 'spam' | 'borderline' | 'seller' | 'low' | 'nolink';
type Conn = Row & Rating;

/** What a profile page or a Connections-list row shows now. `mutuals` is the "N mutual connections" count. */
export interface Live {
  headline: string;
  location?: string;
  company?: string;
  mutuals?: number;
}

const job = (c: Conn) => `${c.position} ${c.company}`;

/** The levels, first match wins. A keep word or place beats a pitch or a sales title: a founder who pitched is a founder. */
const LEVELS: [(c: Conn, r: Rules) => boolean, Level, string | ((c: Conn) => string)][] = [
  [(c) => !c.url, 'nolink', 'no profile link in the export'],
  [(c) => c.tier === 'PROTECTED' || c.tier === 'KEEP', 'core', (c) => c.reason],
  [(c) => c.reason === 'override', 'spam', 'your remove mark'],
  [(c, r) => hasWord(job(c), [...r.mission, ...r.places]), 'core', 'mission or place words'],
  [(c) => c.reason === 'pitch', 'spam', 'pitched you, never answered'],
  [(c, r) => hasWord(c.position, r.spam_titles) || hasWord(c.company, r.spam_companies), 'spam', 'spam title or freelance site'],
  [(c) => c.reason === 'empty', 'borderline', 'empty in the export'],
  [(c, r) => hasWord(c.position, r.sales) && hasWord(c.company, r.seller_companies), 'borderline', 'seller at an agency or dev shop'],
  [(c, r) => hasWord(c.position, r.sales), 'seller', 'a sales title'],
];

/** The level of one rated connection, and why, from the export alone. */
export function levelOf(c: Conn, rules: Rules): [Level, string] {
  for (const [test, level, why] of LEVELS) if (test(c, rules)) return [level, typeof why === 'string' ? why : why(c)];
  return ['low', 'no reason to remove (time alone is not one)'];
}

/** The levels connections_next works through, in order. Sellers only when the member's rules say `also_remove: ["seller"]`. */
export const queueLevels = (rules: Rules): Level[] => ['spam', 'borderline', ...(rules.also_remove.includes('seller') ? (['seller'] as Level[]) : [])];

const blank = (s: string | undefined) => (s ?? '').replace(/[-–—.\s]/g, '').length < 3;

/** Why the live page keeps this connection, or undefined. A place keeps anyone; keep words keep all but your own remove mark. */
function keptBy(c: Conn, live: Live, rules: Rules): string | undefined {
  if (hasWord(`${live.location ?? ''} ${live.company ?? ''}`, rules.places)) return 'rescue place on the page';
  if (c.reason !== 'override' && hasWord(`${live.headline} ${live.company ?? ''}`, rules.mission)) return 'mission words on the page';
  return undefined;
}

type Proof = (c: Conn, live: Live, r: Rules, why: string) => string | undefined;
/** The live proof each removable level needs, and what SKIP says without it. */
const PROOF: Partial<Record<Level, [Proof, string]>> = {
  spam: [
    (c, live, r, why) =>
      ['override', 'pitch'].includes(c.reason) ? c.reason : hasWord(live.headline, [...r.spam_titles, ...r.seller_headlines]) || hasWord(live.company ?? '', r.spam_companies) ? why : undefined,
    'the page no longer shows spam',
  ],
  borderline: [
    (_c, live, r) =>
      hasWord(live.headline, r.seller_headlines)
        ? 'sales pitch in the headline'
        : blank(live.headline) && blank(live.company) && (live.mutuals ?? Infinity) < r.bare_mutuals
          ? 'bare profile, few mutual connections'
          : undefined,
    'no live proof (pass company and mutuals)',
  ],
  seller: [(_c, live, r) => (hasWord(live.headline, [...r.sales, ...r.seller_headlines]) ? 'still selling' : undefined), 'the headline no longer sells'],
};

/** REMOVE only with live proof, and only for a level the member removes. */
export function liveVerdict(c: Conn, live: Live, rules: Rules): { verdict: 'REMOVE' | 'SKIP'; level: Level; reason: string } {
  const [level, why] = levelOf(c, rules);
  const out = (go: boolean, reason: string) => ({ verdict: go ? ('REMOVE' as const) : ('SKIP' as const), level, reason });
  const kept = keptBy(c, live, rules);
  if (kept) return out(false, kept);
  const proof = queueLevels(rules).includes(level) ? PROOF[level] : undefined;
  if (!proof) return out(false, `${level}: ${why}`);
  const shown = proof[0](c, live, rules, why);
  return out(Boolean(shown), shown ?? proof[1]);
}
