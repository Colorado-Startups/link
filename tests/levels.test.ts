// SPDX-License-Identifier: Apache-2.0
// The four levels and the live proof (src/levels.ts). Every person and company here is fictional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levelOf, liveVerdict } from '../src/levels.ts';
import { loadRules, type Rating, type Row } from '../src/rater.ts';

const RULES = { ...loadRules({}), mission: ['founder', 'investor'], places: ['springfield'] };
const row = (over: Partial<Row & Rating>): Row & Rating => ({
  first: 'Ada', last: 'Example', url: 'https://www.linkedin.com/in/example-ada', email: '', company: 'Acme', position: 'Analyst',
  connected: '2020-01-01', sent: 0, received: 0, started: false, endorsed: false, invited: false, pitchFirst: false, keep: false,
  tier: 'REMOVE', reason: 'low', ...over,
});

test('levelOf: core, spam, borderline, low and nolink from the export', () => {
  const cases: [string, Partial<Row & Rating>, string][] = [
    ['no link', { url: '' }, 'nolink'],
    ['protected', { tier: 'PROTECTED', reason: 'thread' }, 'core'],
    ['mission', { tier: 'KEEP', reason: 'mission' }, 'core'],
    ['pitch', { reason: 'pitch' }, 'spam'],
    ['pitching founder', { reason: 'pitch', position: 'Founder', company: 'Acme' }, 'core'],
    ['sales title at a startup', { reason: 'sales', position: 'Head of Sales', company: 'Springfield Labs' }, 'core'],
    ['freelance site', { reason: 'low', company: 'Upwork', position: 'Designer' }, 'spam'],
    ['spam title', { reason: 'low', position: 'Virtual Assistant' }, 'spam'],
    ['empty', { reason: 'empty', position: '', company: '' }, 'borderline'],
    ['agency seller', { reason: 'sales', position: 'Sales Manager', company: 'Acme Outsourcing' }, 'borderline'],
    ['sales title', { reason: 'sales', position: 'Head of Sales', company: 'Acme' }, 'seller'],
    ['no contact for years', { reason: 'low' }, 'low'],
  ];
  for (const [label, over, level] of cases) assert.equal(levelOf(row(over), RULES)[0], level, label);
});

test('liveVerdict: REMOVE only with live proof, and the page can always keep someone', () => {
  const v = (over: Partial<Row & Rating>, live: object) => liveVerdict(row(over), { headline: '', ...live }, RULES).verdict;
  const freelancer = { company: 'Upwork', position: 'Designer' };
  assert.equal(v(freelancer, { headline: 'Designer', company: 'Upwork' }), 'REMOVE');
  assert.equal(v(freelancer, { headline: 'Operations manager', company: 'Acme Textiles' }), 'SKIP');
  assert.equal(v(freelancer, { headline: 'Designer', company: 'Upwork', location: 'Springfield' }), 'SKIP');
  const empty = { reason: 'empty', position: '', company: '' };
  assert.equal(v(empty, { company: '', mutuals: 2 }), 'REMOVE');
  assert.equal(v(empty, { headline: '.', company: '', mutuals: 2 }), 'REMOVE');
  assert.equal(v(empty, { company: '', mutuals: 72 }), 'SKIP');
  assert.equal(v(empty, { company: '' }), 'SKIP');
  assert.equal(v(empty, { company: 'City of Springfield', mutuals: 2 }), 'SKIP');
  assert.equal(v(empty, { headline: 'Startup founder', mutuals: 2 }), 'SKIP');
  assert.equal(v(empty, { headline: 'I help SaaS teams book a call', mutuals: 40 }), 'REMOVE');
  assert.equal(v({ reason: 'pitch' }, { headline: 'Growth consultant' }), 'REMOVE');
  assert.equal(v({ reason: 'pitch' }, { headline: 'Angel investor' }), 'SKIP');
  assert.equal(v({ reason: 'sales', position: 'Head of Sales' }, { headline: '' }), 'SKIP');
  assert.equal(v({ tier: 'PROTECTED', reason: 'thread' }, { mutuals: 0 }), 'SKIP');
});

test('sellers: kept unless the rules opt in, then removed only while the headline still sells', () => {
  const seller = row({ reason: 'sales', position: 'Account Executive', company: 'Acme' });
  const opted = { ...RULES, also_remove: ['seller'] };
  const v = (rules: typeof RULES, headline: string) => liveVerdict(seller, { headline }, rules);
  assert.deepEqual(v(RULES, 'Account Executive at Acme'), { verdict: 'SKIP', level: 'seller', reason: 'seller: a sales title' });
  assert.deepEqual(v(opted, 'Account Executive at Acme'), { verdict: 'REMOVE', level: 'seller', reason: 'still selling' });
  assert.equal(v(opted, 'Operations lead at Acme').reason, 'the headline no longer sells');
  assert.equal(v(opted, 'Founder, account executive by trade').verdict, 'SKIP');
});
