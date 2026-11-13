// SPDX-License-Identifier: Apache-2.0
// The version contract: Link pins one LinkedIn API version, and this test goes red 30 days before that version's
// sunset, while there is still time to move. The fix is a newer version and sunset in quality/api-version.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pinned from '../quality/api-version.json' with { type: 'json' };
import { API_VERSION } from '../src/session.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from `today` (epoch ms) to the start of the sunset date, UTC. */
function daysUntil(sunset: string, today: number): number {
  return Math.floor((Date.parse(`${sunset}T00:00:00Z`) - today) / DAY_MS);
}

test('the pinned version is a YYYYMM LinkedIn version, and the one every request sends', () => {
  assert.match(pinned.version, /^20\d{2}(0[1-9]|1[0-2])$/);
  assert.equal(API_VERSION, pinned.version);
});

test('the rule itself: 31 days before the sunset passes, 30 days and any later day fail', () => {
  assert.equal(daysUntil('2027-10-31', Date.parse('2027-09-30T00:00:00Z')) > 30, true);
  assert.equal(daysUntil('2027-10-31', Date.parse('2027-10-01T00:00:00Z')) > 30, false);
  assert.equal(daysUntil('2027-10-31', Date.parse('2027-11-05T12:00:00Z')) > 30, false);
});

test('the pinned version is more than 30 days from its sunset', () => {
  assert.match(pinned.sunset, /^\d{4}-\d{2}-\d{2}$/);
  const daysLeft = daysUntil(pinned.sunset, Date.now());
  assert.ok(Number.isFinite(daysLeft), `sunset ${pinned.sunset} is a date`);
  assert.ok(
    daysLeft > 30,
    `LinkedIn API version ${pinned.version} sunsets on ${pinned.sunset}, ${daysLeft} days from today. Pin a newer version in quality/api-version.json.`,
  );
});
