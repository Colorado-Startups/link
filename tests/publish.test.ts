// SPDX-License-Identifier: Apache-2.0
// post_publish against a fake LinkedIn: the three post kinds, the dry run, each failure and the ledger. No spec here
// carries an Authorization header: the trusted helper adds it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LinkError } from '../src/core.ts';
import { publishPost } from '../src/publish.ts';
import { API_VERSION } from '../src/session.ts';
import {
  AUTHOR, DOCUMENT_UPLOAD_URL, IMAGE_UPLOAD_URL, POST_URN,
  fakeLinkedIn, liveConfig, mediaFile, reply, tempDir,
} from './fake-linkedin.ts';

const API_HEADERS = { 'Linkedin-Version': API_VERSION, 'X-Restli-Protocol-Version': '2.0.0' };
const JSON_HEADERS = { ...API_HEADERS, 'Content-Type': 'application/json' };
const POST_URL = `https://www.linkedin.com/feed/update/${POST_URN}/`;

/** The post body LinkedIn's Posts API documents, for a text post. */
function postBody(commentary: string, extra: Record<string, unknown> = {}) {
  return {
    author: AUTHOR,
    commentary,
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
    ...extra,
  };
}

/** Asserts the call rejects with a LinkError and returns it. */
async function linkError(work: Promise<unknown>): Promise<LinkError> {
  const error = await work.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  assert.ok(error instanceof LinkError, `expected a LinkError, got ${String(error)}`);
  return error;
}

test('a text post: userinfo, then one POST to /rest/posts with the documented body and headers', async () => {
  const linkedin = fakeLinkedIn();
  const result = await publishPost({ text: 'Shipping day (v1) #launch' }, liveConfig(), linkedin.transport);

  assert.deepEqual(linkedin.calls, [
    { method: 'GET', url: 'https://api.linkedin.com/v2/userinfo', headers: API_HEADERS },
    {
      method: 'POST',
      url: 'https://api.linkedin.com/rest/posts',
      headers: JSON_HEADERS,
      json: postBody('Shipping day \\(v1\\) #launch'),
    },
  ]);
  assert.deepEqual(result, { urn: POST_URN, url: POST_URL, kind: 'text', chars: 25, ledger: 'written' });
});

test('no spec carries an Authorization header: the helper alone adds the token', async () => {
  const linkedin = fakeLinkedIn();
  await publishPost({ text: 'x', media: mediaFile('a.png') }, liveConfig(), linkedin.transport);
  assert.equal(linkedin.calls.length, 4);
  for (const spec of linkedin.calls) {
    assert.ok(!Object.keys(spec.headers).some((name) => name.toLowerCase() === 'authorization'), spec.url);
  }
});

test('visibility CONNECTIONS reaches the post body', async () => {
  const linkedin = fakeLinkedIn();
  await publishPost({ text: 'For connections', visibility: 'CONNECTIONS' }, liveConfig(), linkedin.transport);
  assert.equal((linkedin.calls[1].json as { visibility: string }).visibility, 'CONNECTIONS');
});

test('an image post: initializeUpload, a PUT of the file by path, then the post with the image URN', async () => {
  const linkedin = fakeLinkedIn();
  const path = mediaFile('chart.PNG', 'png bytes');
  const result = await publishPost({ text: 'A chart', media: path, title: 'not used' }, liveConfig(), linkedin.transport);

  assert.deepEqual(linkedin.calls.slice(1), [
    {
      method: 'POST',
      url: 'https://api.linkedin.com/rest/images?action=initializeUpload',
      headers: JSON_HEADERS,
      json: { initializeUploadRequest: { owner: AUTHOR } },
    },
    { method: 'PUT', url: IMAGE_UPLOAD_URL, headers: {}, file: path },
    {
      method: 'POST',
      url: 'https://api.linkedin.com/rest/posts',
      headers: JSON_HEADERS,
      json: postBody('A chart', { content: { media: { id: 'urn:li:image:IMG1' } } }),
    },
  ]);
  assert.equal(result.kind, 'image');
  assert.equal(result.urn, POST_URN);
});

test('a PDF post: the documents endpoint, then the post with the document URN and its title', async () => {
  const linkedin = fakeLinkedIn();
  const path = mediaFile('deck.pdf', '%PDF-1.7 fake');
  const result = await publishPost({ text: 'A carousel', media: path, title: 'Five lessons' }, liveConfig(), linkedin.transport);

  assert.deepEqual(
    linkedin.calls.map((spec) => `${spec.method} ${spec.url}`),
    [
      'GET https://api.linkedin.com/v2/userinfo',
      'POST https://api.linkedin.com/rest/documents?action=initializeUpload',
      `PUT ${DOCUMENT_UPLOAD_URL}`,
      'POST https://api.linkedin.com/rest/posts',
    ],
  );
  assert.deepEqual(linkedin.calls[1].json, { initializeUploadRequest: { owner: AUTHOR } });
  assert.equal(linkedin.calls[2].file, path);
  assert.deepEqual(
    linkedin.calls[3].json,
    postBody('A carousel', { content: { media: { id: 'urn:li:document:DOC1', title: 'Five lessons' } } }),
  );
  assert.equal(result.kind, 'document');
});

test('a dry run calls no transport, writes no ledger, and returns each request in order', async () => {
  const linkedin = fakeLinkedIn();
  const config = { ...liveConfig(), dryRun: true };
  const path = mediaFile('deck.pdf', '12345');
  const result = await publishPost({ text: 'Dry (run)', media: path, title: 'Deck' }, config, linkedin.transport);

  assert.equal(linkedin.calls.length, 0);
  assert.equal(existsSync(config.home), false);
  assert.deepEqual(result, {
    dry_run: true,
    requests: [
      { method: 'GET', url: 'https://api.linkedin.com/v2/userinfo', headers: API_HEADERS },
      {
        method: 'POST',
        url: 'https://api.linkedin.com/rest/documents?action=initializeUpload',
        headers: JSON_HEADERS,
        json: { initializeUploadRequest: { owner: 'urn:li:person:SUB_FROM_USERINFO' } },
      },
      {
        method: 'PUT',
        url: 'https://www.linkedin.com/dms-uploads/URL_FROM_INITIALIZE_UPLOAD',
        headers: {},
        file: path,
        bytes: 5,
      },
      {
        method: 'POST',
        url: 'https://api.linkedin.com/rest/posts',
        headers: JSON_HEADERS,
        json: {
          ...postBody('Dry \\(run\\)', {
            content: { media: { id: 'urn:li:document:ID_FROM_INITIALIZE_UPLOAD', title: 'Deck' } },
          }),
          author: 'urn:li:person:SUB_FROM_USERINFO',
        },
      },
    ],
  });
});

test('a dry run plans the same requests a live run sends, apart from what LinkedIn returns', async () => {
  const path = mediaFile('photo.jpg', 'jpg bytes');
  const input = { text: 'Same [shape]', media: path };
  const live = fakeLinkedIn();
  await publishPost(input, liveConfig(), live.transport);
  const dry = await publishPost(input, { ...liveConfig(), dryRun: true }, fakeLinkedIn().transport);
  const planned = dry.requests as { method: string; url: string; headers: Record<string, string>; file?: string }[];

  const shape = (spec: { method: string; url: string; headers: Record<string, string>; file?: string }) =>
    [spec.method, new URL(spec.url).host, Object.keys(spec.headers), spec.file];
  assert.deepEqual(planned.map(shape), live.calls.map(shape));
});

test('401: the error names the Token Generator fix, and nothing is published or written', async () => {
  const linkedin = fakeLinkedIn({ 'GET /v2/userinfo': () => reply(401, { message: 'Invalid access token', status: 401 }) });
  const config = liveConfig();
  const error = await linkError(publishPost({ text: 'x' }, config, linkedin.transport));
  assert.equal(
    error.message,
    "Token expired or invalid. Generate a new one in LinkedIn's Token Generator and store it (about 1 minute).",
  );
  assert.equal(linkedin.calls.length, 1);
  assert.equal(existsSync(config.home), false);
});

test('403 on a /rest call: the error says the app may lack access and carries what LinkedIn said', async () => {
  const said = 'Accessing this document resource is forbidden. Please check your permissions for this resource';
  const linkedin = fakeLinkedIn({ 'POST /rest/documents': () => reply(403, { message: said, status: 403 }) });
  const path = mediaFile('deck.pdf');
  const error = await linkError(publishPost({ text: 'x', media: path, title: 'Deck' }, liveConfig(), linkedin.transport));
  assert.equal(
    error.message,
    `LinkedIn refused POST api.linkedin.com/rest/documents (403). The app may lack access to this endpoint. LinkedIn said: ${said}`,
  );
  assert.equal(linkedin.calls.length, 2, 'no upload and no post after the refusal');
});

test('any other LinkedIn answer that is not a success reports the status and what LinkedIn said', async () => {
  const cases: [number, unknown, string][] = [
    [400, { message: 'commentary length exceeds the allowed maximum' }, 'commentary length exceeds the allowed maximum'],
    [302, null, 'nothing'],
    [500, 'not json', 'nothing'],
  ];
  for (const [status, body, said] of cases) {
    const linkedin = fakeLinkedIn({ 'POST /rest/posts': () => reply(status, body) });
    const error = await linkError(publishPost({ text: 'x' }, liveConfig(), linkedin.transport));
    assert.equal(error.message, `LinkedIn returned ${status} for POST api.linkedin.com/rest/posts. LinkedIn said: ${said}`);
  }
});

test('a transport failure, such as a cancelled approval, stops the post and writes no ledger line', async () => {
  const cancelled = new LinkError('You cancelled in the approval dialog. Nothing was sent.');
  const linkedin = fakeLinkedIn({
    'POST /rest/posts': () => {
      throw cancelled;
    },
  });
  const config = liveConfig();
  assert.equal(await linkError(publishPost({ text: 'x' }, config, linkedin.transport)), cancelled);
  assert.equal(existsSync(config.home), false);
});

test('bad media: a relative path, a wrong extension, a missing file and a folder each fail before any call', async () => {
  const linkedin = fakeLinkedIn();
  const folder = join(tempDir(), 'folder.png');
  mkdirSync(folder);
  const cases: [string, RegExp][] = [
    ['deck.pdf', /^media must be an absolute path\. Got: deck\.pdf$/],
    [mediaFile('notes.docx'), /^media must be a \.pdf, \.png, \.jpg, \.jpeg or \.gif file\. Got: notes\.docx$/],
    [mediaFile('no-extension'), /^media must be a \.pdf, \.png, \.jpg, \.jpeg or \.gif file\./],
    [join(tempDir(), 'missing.png'), /^media file not found or not readable: .*missing\.png$/],
    [folder, /^media file not found or not readable: .*folder\.png$/],
  ];
  for (const [media, message] of cases) {
    const error = await linkError(publishPost({ text: 'x', media, title: 'T' }, liveConfig(), linkedin.transport));
    assert.match(error.message, message);
  }
  assert.equal(linkedin.calls.length, 0);
});

test('a PDF without a title fails before any call', async () => {
  const linkedin = fakeLinkedIn();
  const path = mediaFile('deck.pdf');
  for (const title of [undefined, '   ']) {
    const error = await linkError(publishPost({ text: 'x', media: path, title }, liveConfig(), linkedin.transport));
    assert.equal(error.message, 'title is required when media is a PDF.');
  }
  assert.equal(linkedin.calls.length, 0);
});

test('the ledger gets one JSON line per post, in a 700 folder and a 600 file', async () => {
  const config = liveConfig();
  const text = 'Ledger (test) #one';
  const now = new Date('2026-11-12T18:30:00.000Z');
  await publishPost({ text }, config, fakeLinkedIn().transport, now);
  await publishPost({ text: 'Second', media: mediaFile('deck.pdf'), title: 'Deck' }, config, fakeLinkedIn().transport, now);

  const file = join(config.home, 'ledger.jsonl');
  const raw = readFileSync(file, 'utf8');
  assert.ok(raw.endsWith('\n'));
  const lines = raw.trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines, [
    {
      time: '2026-11-12T18:30:00.000Z',
      kind: 'text',
      urn: POST_URN,
      url: POST_URL,
      chars: text.length,
      sha256: createHash('sha256').update(text).digest('hex'),
      media: null,
    },
    {
      time: '2026-11-12T18:30:00.000Z',
      kind: 'document',
      urn: POST_URN,
      url: POST_URL,
      chars: 6,
      sha256: createHash('sha256').update('Second').digest('hex'),
      media: 'deck.pdf',
    },
  ]);
  assert.equal(statSync(config.home).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('a post that went out is still reported when the ledger cannot be written', async () => {
  // LINK_HOME sits under a plain file, so the folder cannot be made.
  const blocker = join(tempDir(), 'file');
  writeFileSync(blocker, '');
  const config = { ...liveConfig(), home: join(blocker, 'home') };
  const result = await publishPost({ text: 'Still live' }, config, fakeLinkedIn().transport);
  assert.equal(result.urn, POST_URN);
  assert.match(String(result.ledger), /^not written: could not append to .*ledger\.jsonl$/);
});

test('a post LinkedIn accepts without a URN fails with a warning to check before posting again', async () => {
  const linkedin = fakeLinkedIn({ 'POST /rest/posts': () => reply(201) });
  const error = await linkError(publishPost({ text: 'x' }, liveConfig(), linkedin.transport));
  assert.match(error.message, /returned no post URN .* Check the profile before posting again\.$/);
});
