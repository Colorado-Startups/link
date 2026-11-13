// SPDX-License-Identifier: Apache-2.0
// End to end over stdio, which the in-process tests cannot cover: the real server as a child process, spoken to in MCP
// over its stdin and stdout as a host runs it, with tests/fixtures/fake-helper.mjs as LINK_HELPER_CMD. The specs the
// fixture logs then go through the real helper's own checks. Nothing here can post: no token, no network, no dialog.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { needsApproval, validateSpec } from '../trusted/link-linkedin.mjs';

type Message = Record<string, any>;

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const jsonLines = (file: string): Message[] =>
  readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const POST_URN = 'urn:li:share:7000000000000000042';

const stdout: string[] = [];
let partial = '';
let exitCode: number | null = null;
let initialize: Message, tools: Message, post: Message;
let specs: Message[], ledger: Message[];

// One server for the file: the opening exchange, tools/list, one text post, then stdin closes and the server exits.
before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'link-e2e-'));
  const log = join(dir, 'specs.jsonl');
  const env = {
    HOME: dir,
    LINK_HOME: join(dir, 'home'),
    LINK_HELPER_CMD: JSON.stringify([process.execPath, path('./fixtures/fake-helper.mjs'), '--log', log]),
  };
  const server = spawn(process.execPath, [path('../src/server.ts')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise<number | null>((resolve) => server.on('close', resolve));
  const waiting = new Map<number, (message: Message) => void>();
  server.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    const lines = (partial + chunk).split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) {
      stdout.push(line);
      try {
        const message = JSON.parse(line);
        waiting.get(message.id)?.(message);
      } catch {
        // Not JSON: the stdout test reports it.
      }
    }
  });
  let id = 0;
  const send = (message: Message) => server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const request = (method: string, params: Message = {}) =>
    new Promise<Message>((resolve) => {
      waiting.set(++id, resolve);
      send({ id, method, params });
    });

  initialize = await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'link-e2e-test', version: '0.0.0' },
  });
  send({ method: 'notifications/initialized' });
  tools = await request('tools/list');
  post = await request('tools/call', { name: 'post_publish', arguments: { text: 'Hello (e2e) #launch' } });
  server.stdin.end();
  exitCode = await exited;
  specs = jsonLines(log);
  ledger = jsonLines(join(dir, 'home', 'ledger.jsonl'));
}, { timeout: 20_000 });

test('over stdio the server answers initialize, then tools/list returns exactly the ten tools', () => {
  assert.equal(initialize.result.protocolVersion, '2025-11-25');
  assert.equal(initialize.result.serverInfo.name, 'link');
  assert.deepEqual(
    tools.result.tools.slice(0, 2).map(({ name, annotations }: Message) => ({ name, annotations })),
    [
      { name: 'link_status', annotations: { readOnlyHint: true } },
      { name: 'post_publish', annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
    ],
  );
  assert.equal(tools.result.tools.length, 10);
});

test('a text post: two specs reach the helper, one ledger line, and every stdout line is JSON-RPC', () => {
  assert.notEqual(post.result.isError, true, post.result.content[0].text);
  assert.equal(JSON.parse(post.result.content[0].text).urn, POST_URN);
  assert.deepEqual(specs.map(({ method, url }) => `${method} ${url}`), [
    'GET https://api.linkedin.com/v2/userinfo',
    'POST https://api.linkedin.com/rest/posts',
  ]);
  assert.equal(specs[1].json.author, 'urn:li:person:fakeE2eMember');
  assert.equal(specs[1].json.commentary, 'Hello \\(e2e\\) #launch');
  assert.deepEqual(ledger.map(({ kind, urn }) => ({ kind, urn })), [{ kind: 'text', urn: POST_URN }]);
  assert.equal(exitCode, 0, 'the server exits once stdin closes');
  assert.equal(partial, '', 'stdout ends with a whole line');
  assert.equal(stdout.length, 3, 'one answer each to initialize, tools/list and the call, and nothing else');
  for (const line of stdout) assert.equal(JSON.parse(line).jsonrpc, '2.0', line);
});

test("the specs the server sent pass the real helper's checks unchanged, and only the post needs approval", () => {
  assert.equal(specs.length, 2);
  const checked = specs.map((spec) => validateSpec(spec));
  checked.forEach((clean, index) => assert.deepEqual(clean.headers, specs[index].headers));
  assert.deepEqual(checked.map((clean) => needsApproval(clean)), [false, true]);
});
