// SPDX-License-Identifier: Apache-2.0
// comment_create: the request it hands the helper, a reply under a comment, the 403 fallback to the clipboard, the
// gate and the halt file. A fake LinkedIn and a fake desk; nothing reaches the network or the real clipboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTHOR, fakeLinkedIn, liveConfig, reply, tempDir } from './fake-linkedin.ts';
import { call } from './rpc.ts';

const POST = 'urn:li:activity:7000000000000000002';
const POST_PAGE = `https://www.linkedin.com/feed/update/${POST}/`;

function setup(over: Parameters<typeof fakeLinkedIn>[0] = {}) {
  const linkedin = fakeLinkedIn({ 'POST /v2/socialActions/': () => reply(201, null, { 'x-restli-id': '7000000000000000009' }), ...over });
  const config = liveConfig();
  const desk: string[] = [];
  const fake = { copy: async (t: string) => void desk.push(`copy ${t}`), open: async (u: string) => void desk.push(`open ${u}`) };
  const halt = join(tempDir(), 'halt');
  const tool = async (args: Record<string, unknown>, cfg = config) => {
    const r = await call(cfg, linkedin.transport, 'comment_create', args, { PATH: process.env.PATH, LINK_HALT_FILE: halt }, fake);
    return { isError: r.isError, text: r.content[0].text, json: r.isError ? undefined : JSON.parse(r.content[0].text) };
  };
  return { linkedin, config, desk, halt, tool };
}

test('a comment on a post: one userinfo read, one POST to /v2/socialActions, plain text, a ledger line', async () => {
  const { linkedin, config, tool } = setup();
  const out = (await tool({ post: POST_PAGE, text: 'Great point (really) #fusion' })).json;
  assert.deepEqual([out.sent, out.comment, out.url], [true, '7000000000000000009', POST_PAGE]);
  const spec = linkedin.calls[1];
  assert.equal(spec.url, `https://api.linkedin.com/v2/socialActions/${encodeURIComponent(POST)}/comments`);
  assert.deepEqual(spec.json, { actor: AUTHOR, object: POST, message: { text: 'Great point (really) #fusion' } });
  assert.equal(JSON.parse(readFileSync(join(config.home, 'ledger.jsonl'), 'utf8')).kind, 'comment');
});

test('a reply under a comment targets the comment and names it as parentComment, in its full form', async () => {
  const { linkedin, tool } = setup();
  await tool({ post: POST, text: 'Thanks', parent: 'urn:li:comment:(activity:7000000000000000002,7000000000000000003)' });
  const parent = 'urn:li:comment:(urn:li:activity:7000000000000000002,7000000000000000003)';
  assert.equal(linkedin.calls[1].url, `https://api.linkedin.com/v2/socialActions/${encodeURIComponent(parent)}/comments`);
  assert.equal((linkedin.calls[1].json as { parentComment: string }).parentComment, parent);
  assert.match((await tool({ post: POST, text: 'x', parent: 'urn:li:comment:1' })).text, /parent must be/);
  assert.match((await tool({ post: 'https://example.com/post/1', text: 'x' })).text, /post must be/);
});

test('a comment link or a reply link alone answers the top-level comment; a mismatched link is refused', async () => {
  const { linkedin, tool } = setup();
  const top = 'urn:li:comment:(activity:7000000000000000002,7000000000000000003)';
  const full = 'urn:li:comment:(urn:li:activity:7000000000000000002,7000000000000000003)';
  const commentLink = `${POST_PAGE}?commentUrn=${encodeURIComponent(top)}&dashCommentUrn=x`;
  const replyLink = `${commentLink}&replyUrn=${encodeURIComponent('urn:li:comment:(activity:7000000000000000002,7000000000000000004)')}`;
  for (const post of [commentLink, replyLink]) {
    const before = linkedin.calls.length;
    await tool({ post, text: 'Thanks' });
    assert.equal((linkedin.calls[before + 1].json as { parentComment: string }).parentComment, full);
  }
  const other = `${POST_PAGE}?commentUrn=${encodeURIComponent('urn:li:comment:(activity:7000000000000000099,7000000000000000003)')}`;
  assert.match((await tool({ post: other, text: 'x' })).text, /another post/);
  assert.equal(((await tool({ post: POST_PAGE, text: 'x' })).json as { sent: boolean }).sent, true, 'a post link with no comment still comments on the post');
});

test('on a 403 it copies and opens the post, and later calls skip the endpoint', async () => {
  const { linkedin, config, desk, tool } = setup({ 'POST /v2/socialActions/': () => reply(403, { message: 'Not enough permissions' }) });
  const first = (await tool({ post: POST, text: 'Agreed' })).json;
  assert.deepEqual([first.sent, first.opened], [false, POST_PAGE]);
  assert.ok(existsSync(join(config.home, 'comments-api-refused')));
  const calls = linkedin.calls.length;
  assert.match((await tool({ post: POST, text: 'Again' })).json.reason, /Delete .*comments-api-refused/);
  assert.equal(linkedin.calls.length, calls, 'no second request');
  assert.deepEqual(desk, [`copy Agreed`, `open ${POST_PAGE}`, `copy Again`, `open ${POST_PAGE}`]);
});

test('a dry run, a blocking gate and the halt file each stop it before any request or desk action', async () => {
  const { linkedin, config, desk, halt, tool } = setup();
  const dry = (await tool({ post: POST, text: 'Hi' }, { ...config, dryRun: true })).json;
  assert.deepEqual(dry.requests.map((r: { method: string }) => r.method), ['GET', 'POST']);
  const block = fileURLToPath(new URL('./fixtures/gate-block.mjs', import.meta.url));
  assert.match((await tool({ post: POST, text: 'Hi' }, { ...config, gates: JSON.stringify([[process.execPath, block]]) })).text, /Blocked/);
  writeFileSync(halt, 'warning');
  assert.match((await tool({ post: POST, text: 'Hi' })).text, /Halted/);
  assert.deepEqual([linkedin.calls.length, desk.length], [0, 0]);
});
