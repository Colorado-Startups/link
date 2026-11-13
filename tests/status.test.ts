// SPDX-License-Identifier: Apache-2.0
// link_status against a fake LinkedIn: who the token is, whether it works, and the ledger tail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LinkError } from '../src/core.ts';
import { helperTransport, linkStatus } from '../src/linkedin.ts';
import { API_VERSION } from '../src/session.ts';
import { AUTHOR, fakeLinkedIn, liveConfig, reply } from './fake-linkedin.ts';

test('a working token: name, author URN, version, dry-run off and an empty ledger', async () => {
  const linkedin = fakeLinkedIn();
  const status = await linkStatus(liveConfig(), linkedin.transport);
  assert.deepEqual(status, {
    name: 'Test Member',
    author: AUTHOR,
    token_works: true,
    api_version: API_VERSION,
    dry_run: false,
    ledger: [],
  });
  assert.deepEqual(linkedin.calls, [
    {
      method: 'GET',
      url: 'https://api.linkedin.com/v2/userinfo',
      headers: { 'Linkedin-Version': API_VERSION, 'X-Restli-Protocol-Version': '2.0.0' },
    },
  ]);
});

test('the ledger tail is the last 5 lines, oldest first', async () => {
  const config = liveConfig();
  mkdirSync(config.home, { recursive: true });
  const lines = [1, 2, 3, 4, 5, 6, 7].map((n) => JSON.stringify({ urn: `urn:li:share:${n}` }));
  writeFileSync(join(config.home, 'ledger.jsonl'), `${lines.join('\n')}\n`);
  const status = await linkStatus(config, fakeLinkedIn().transport);
  assert.deepEqual(
    status.ledger,
    [3, 4, 5, 6, 7].map((n) => ({ urn: `urn:li:share:${n}` })),
  );
});

test('401: the token does not work, and the problem names the fix', async () => {
  const linkedin = fakeLinkedIn({ 'GET /v2/userinfo': () => reply(401, { message: 'Invalid access token' }) });
  const status = await linkStatus(liveConfig(), linkedin.transport);
  assert.equal(status.token_works, false);
  assert.equal(
    status.problem,
    "Token expired or invalid. Generate a new one in LinkedIn's Token Generator and store it (about 1 minute).",
  );
  assert.equal(status.author, null);
  assert.equal(status.api_version, API_VERSION);
});

test('the helper had no usable token (exit 4): the token does not work, and the problem names the fix', async () => {
  const helper = JSON.stringify([process.execPath, '-e', 'process.exit(4)']);
  const status = await linkStatus(liveConfig(), helperTransport(helper));
  assert.equal(status.token_works, false);
  assert.equal(
    status.problem,
    "The LinkedIn helper had no usable token. Generate one in LinkedIn's Token Generator and store it (about 1 minute), and check that LINK_HELPER_CMD starts the helper through the key tool.",
  );
});

test('any other failure is an error, not a verdict on the token', async () => {
  const outage = fakeLinkedIn({ 'GET /v2/userinfo': () => reply(503, { message: 'Service unavailable' }) });
  await assert.rejects(linkStatus(liveConfig(), outage.transport), (error: unknown) => {
    assert.ok(error instanceof LinkError);
    assert.equal(error.message, 'LinkedIn returned 503 for GET api.linkedin.com/v2/userinfo. LinkedIn said: Service unavailable');
    return true;
  });
  await assert.rejects(linkStatus(liveConfig(), helperTransport(undefined)), /^Error: LINK_HELPER_CMD is not set\./);
});

test('a dry run calls no transport and returns the one request', async () => {
  const linkedin = fakeLinkedIn();
  const status = await linkStatus({ ...liveConfig(), dryRun: true }, linkedin.transport);
  assert.equal(linkedin.calls.length, 0);
  assert.deepEqual(status, {
    name: null,
    author: null,
    token_works: null,
    api_version: API_VERSION,
    dry_run: true,
    ledger: [],
    requests: [
      {
        method: 'GET',
        url: 'https://api.linkedin.com/v2/userinfo',
        headers: { 'Linkedin-Version': API_VERSION, 'X-Restli-Protocol-Version': '2.0.0' },
      },
    ],
  });
});
