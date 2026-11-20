// SPDX-License-Identifier: Apache-2.0
// Four levels on top of the rater's tiers, and the live proof a profile page must give before anything is removed.
// The goal is to keep every contact that matters and remove only clear spam and bare profiles. The export can be
// years old, so a spam level is never enough on its own: what the page shows now decides. docs/connections.md draws it.
import { hasWord, type Rating, type Row, type Rules } from './rater.ts';

export type Level = 'core' | 'spam' | 'borderline' | 'low' | 'nolink';
/** The order connections_next works in: clear spam first, then borderline. Core and low are never queued. */
export const LEVEL_ORDER: Level[] = ['spam', 'borderline'];

/** What a profile page or a Connections-list row shows now. `mutuals` is the "N mutual connections" count. */
export interface Live {
  headline: string;
  location?: string;
  company?: string;
  mutuals?: number;
}

/** The level of one rated connection, and why, from the export alone. */
export function levelOf(c: Row & Rating, rules: Rules): [Level, string] {
  if (!c.url) return ['nolink', 'no profile link in the export'];
  if (c.tier === 'PROTECTED' || c.tier === 'KEEP') return ['core', c.reason];
  if (c.reason === 'override') return ['spam', 'your remove mark'];
  if (c.reason === 'pitch') return ['spam', 'pitched you, never answered'];
  if (hasWord(c.position, rules.spam_titles) || hasWord(c.company, rules.spam_companies)) return ['spam', 'spam title or freelance site'];
  if (c.reason === 'empty') return ['borderline', 'empty in the export'];
  if (hasWord(c.position, rules.sales) && hasWord(c.company, rules.seller_companies)) return ['borderline', 'seller at an agency or dev shop'];
  return ['low', c.reason === 'sales' ? 'an ordinary sales job' : 'no reason to remove (time alone is not one)'];
}

const blank = (s: string | undefined) => (s ?? '').replace(/[-–—.\s]/g, '').length < 3;

/** Why the live page keeps this connection, or undefined. A place keeps anyone; keep words keep all but pitches and marks. */
export function keptBy(c: Row & Rating, live: Live, rules: Rules): string | undefined {
  if (hasWord(`${live.location ?? ''} ${live.company ?? ''}`, rules.places)) return 'rescue place on the page';
  if (!['pitch', 'override'].includes(c.reason) && hasWord(`${live.headline} ${live.company ?? ''}`, rules.mission)) return 'mission words on the page';
  return undefined;
}

/** REMOVE only with live proof: spam still shown on the page, or a bare profile with few mutual connections. */
export function liveVerdict(c: Row & Rating, live: Live, rules: Rules): { verdict: 'REMOVE' | 'SKIP'; level: Level; reason: string } {
  const [level, why] = levelOf(c, rules);
  const out = (go: boolean, reason: string) => ({ verdict: go ? ('REMOVE' as const) : ('SKIP' as const), level, reason });
  const kept = keptBy(c, live, rules);
  if (kept) return out(false, kept);
  if (level === 'spam') {
    if (['override', 'pitch'].includes(c.reason)) return out(true, c.reason);
    const shown = hasWord(live.headline, [...rules.spam_titles, ...rules.seller_headlines]) || hasWord(live.company ?? '', rules.spam_companies);
    return out(shown, shown ? why : 'the page no longer shows spam');
  }
  if (level === 'borderline') {
    if (hasWord(live.headline, rules.seller_headlines)) return out(true, 'sales pitch in the headline');
    const bare = blank(live.headline) && blank(live.company) && (live.mutuals ?? Infinity) < rules.bare_mutuals;
    return out(bare, bare ? 'bare profile, few mutual connections' : 'no live proof (pass company and mutuals)');
  }
  return out(false, `${level}: ${why}`);
}
