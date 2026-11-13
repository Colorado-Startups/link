// SPDX-License-Identifier: Apache-2.0
// The MCP contract: two tools with titles and annotations, tight described inputs, and every failure a tool error
// (never an exception through the MCP transport). Drives the real server in process, with a fake LinkedIn transport
// or a fake helper process behind it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { POST_URN, fakeLinkedIn, liveConfig, reply } from './fake-linkedin.ts';
import { call, rpc } from './rpc.ts';

test('lists exactly the eleven tools, each with a title, a description and its annotations', async () => {
  const out = await rpc(liveConfig(), fakeLinkedIn().transport, 'tools/list');
  const tools = out.result.tools as { name: string; title: string; description: string; annotations: Record<string, unknown> }[];
  assert.deepEqual(tools.map((tool) => tool.name), ['link_status', 'post_publish', 'comment_create', 'archive_load', 'connections_list', 'connections_mark', 'connections_next', 'connections_check', 'inbox_next', 'inbox_mark', 'reply_open']);
  for (const tool of tools) {
    assert.ok(tool.title, `${tool.name} has a title`);
    assert.ok(tool.description.length > 40, `${tool.name} has a description`);
  }
  const [status, publish] = tools;
  for (const tool of tools.slice(3, -1)) assert.equal(tool.annotations.openWorldHint, false, `${tool.name} does not touch LinkedIn`);
  assert.deepEqual(status.annotations, { readOnlyHint: true });
  assert.deepEqual(publish.annotations, { readOnlyHint: false, destructiveHint: false, openWorldHint: true });
});

test('post_publish takes text, media, title and visibility only, each described, with text required', async () => {
  const out = await rpc(liveConfig(), fakeLinkedIn().transport, 'tools/list');
  const { inputSchema } = out.result.tools[1];
  assert.deepEqual(Object.keys(inputSchema.properties), ['text', 'media', 'title', 'visibility']);
  for (const [name, property] of Object.entries(inputSchema.properties as Record<string, { description?: string }>)) {
    assert.ok(property.description, `${name} has a description`);
  }
  assert.deepEqual(inputSchema.required, ['text']);
  assert.equal(inputSchema.additionalProperties, false);
  assert.deepEqual(inputSchema.properties.visibility.enum, ['PUBLIC', 'CONNECTIONS']);
});

test('post_publish returns the URN and the URL as JSON text, with visibility PUBLIC by default', async () => {
  const linkedin = fakeLinkedIn();
  const result = await call(liveConfig(), linkedin.transport, 'post_publish', { text: 'Hello' });
  assert.notEqual(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    urn: POST_URN,
    url: `https://www.linkedin.com/feed/update/${POST_URN}/`,
    kind: 'text',
    chars: 5,
    ledger: 'written',
  });
  assert.equal((linkedin.calls[1].json as { visibility: string }).visibility, 'PUBLIC');
});

test('link_status returns its status as JSON text', async () => {
  const result = await call(liveConfig(), fakeLinkedIn().transport, 'link_status');
  assert.notEqual(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).token_works, true);
});

test('a 401 from LinkedIn is a tool error that names the fix', async () => {
  const linkedin = fakeLinkedIn({ 'GET /v2/userinfo': () => reply(401, { message: 'Invalid access token' }) });
  const result = await call(liveConfig(), linkedin.transport, 'post_publish', { text: 'Hello' });
  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    "Token expired or invalid. Generate a new one in LinkedIn's Token Generator and store it (about 1 minute).",
  );
});

test('input the schema refuses is a tool error, and nothing is sent', async () => {
  const linkedin = fakeLinkedIn();
  const refused: Record<string, unknown>[] = [
    {},
    { text: '' },
    { text: 'x', visibility: 'PRIVATE' },
    { text: 'x', schedule: 'tomorrow' },
    { text: 'x', media: 42 },
  ];
  for (const args of refused) {
    const result = await call(liveConfig(), linkedin.transport, 'post_publish', args);
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(linkedin.calls.length, 0);
});

test('with LINK_HELPER_CMD unset, both tools return a tool error that names the fix', async () => {
  const fix =
    'LINK_HELPER_CMD is not set. Set it to the command that starts the helper with the token, as a JSON array of strings, for example ["/bin/sh","-c","LINKEDIN_ACCESS_TOKEN=\\"$(/usr/bin/security find-generic-password -s link-linkedin -w)\\" exec /usr/local/bin/link-linkedin"].';
  for (const [name, args] of [['link_status', {}], ['post_publish', { text: 'Hello' }]] as const) {
    const result = await call(liveConfig(), undefined, name, args);
    assert.equal(result.isError, true, name);
    assert.equal(result.content[0].text, fix);
  }
});

test('a cancelled approval dialog (helper exit 3) is a tool error, and no ledger line is written', async () => {
  // A stand-in helper: it answers the userinfo read, and exits 3 for the post, as the helper does on Cancel.
  const script =
    "let s='';process.stdin.on('data',(d)=>(s+=d)).on('end',()=>{if(JSON.parse(s).method==='GET'){process.stdout.write(JSON.stringify({status:200,headers:{},body:{sub:'fakeMember123'}}))}else{process.stdout.write('{\"error\":\"not approved\"}');process.exitCode=3}})";
  const config = { ...liveConfig(), helper: JSON.stringify([process.execPath, '-e', script]) };
  const result = await call(config, undefined, 'post_publish', { text: 'Hello' });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'You cancelled in the approval dialog. Nothing was sent.');
  const status = JSON.parse((await call(config, undefined, 'link_status')).content[0].text);
  assert.deepEqual(status.ledger, []);
  assert.equal(status.author, 'urn:li:person:fakeMember123');
});

test("no tool result carries a token-shaped string from the helper's stderr", async () => {
  const tokenShaped = 'AQXfakeTokenShapedString0123456789';
  for (const exit of [0, 1, 2, 3, 4, 5]) {
    const script = `process.stderr.write('Authorization: Bearer ${tokenShaped}');process.exit(${exit})`;
    const config = { ...liveConfig(), helper: JSON.stringify([process.execPath, '-e', script]) };
    for (const [name, args] of [['link_status', {}], ['post_publish', { text: 'Hello' }]] as const) {
      const result = await call(config, undefined, name, args);
      assert.ok(!JSON.stringify(result).includes(tokenShaped), `${name}, exit ${exit}`);
      assert.ok(!JSON.stringify(result).includes('Bearer'), `${name}, exit ${exit}`);
    }
  }
});

test('an unexpected failure is a plain tool error with none of its own message', async () => {
  // The ledger path is a folder, so reading it throws something Link does not expect.
  const config = liveConfig();
  mkdirSync(join(config.home, 'ledger.jsonl'), { recursive: true });
  const result = await call(config, fakeLinkedIn().transport, 'link_status');
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'Link hit an unexpected error. Try again. If it repeats, the server log names the error.');
});

test('with dry-run on, both tools answer without a helper and without one transport call', async () => {
  const config = { ...liveConfig(), dryRun: true };
  const linkedin = fakeLinkedIn();
  for (const transport of [linkedin.transport, undefined]) {
    const status = JSON.parse((await call(config, transport, 'link_status')).content[0].text);
    const publish = JSON.parse((await call(config, transport, 'post_publish', { text: 'Dry' })).content[0].text);
    assert.equal(status.dry_run, true);
    assert.equal(publish.dry_run, true);
    assert.equal(publish.requests.length, 2);
  }
  assert.equal(linkedin.calls.length, 0);
});
