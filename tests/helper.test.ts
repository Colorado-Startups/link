// SPDX-License-Identifier: Apache-2.0
// The trusted helper (trusted/link-linkedin.mjs): the one program that holds the token and the approval dialog.
// Every test passes a fake fetch, a fake approval and a fake execFile: no network, no dialog, no osascript.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EXIT, Refused, askHuman, dialogArgs, needsApproval, run, shapeResult, validateSpec } from '../trusted/link-linkedin.mjs';

const TOKEN = 'fake-token-for-tests';
const HELPER = fileURLToPath(new URL('../trusted/link-linkedin.mjs', import.meta.url));
const POST = {
  method: 'POST',
  url: 'https://api.linkedin.com/rest/posts',
  headers: { 'Linkedin-Version': '202610', 'X-Restli-Protocol-Version': '2.0.0', 'Content-Type': 'application/json' },
  json: { author: 'urn:li:person:fakeMember123', commentary: 'Hello LinkedIn', visibility: 'PUBLIC' },
};

interface Sent {
  url: string;
  init: { method: string; headers: Record<string, string>; body: unknown; redirect: string };
}

/** The three things the helper touches, faked, with a record of what it did with each. */
function world(options: { approve?: boolean; respond?: () => Response; file?: string } = {}) {
  const sent: Sent[] = [];
  const asked: string[][] = [];
  const read: string[] = [];
  const deps = {
    fetch: async (url: string, init: Sent['init']) => {
      sent.push({ url, init });
      return (options.respond ?? (() => new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:1' } })))();
    },
    approve: async (args: string[]) => {
      asked.push(args);
      return options.approve ?? false;
    },
    readFile: async (path: string) => {
      read.push(path);
      if (options.file === undefined) throw new Error('ENOENT');
      return Buffer.from(options.file);
    },
  };
  return { deps, sent, asked, read };
}

/** Runs the helper on a spec with the fake token and returns the exit code and the parsed stdout line. */
async function helper(spec: unknown, deps: ReturnType<typeof world>['deps'], env: Record<string, string> = { LINKEDIN_ACCESS_TOKEN: TOKEN }) {
  const { code, output } = await run(typeof spec === 'string' ? spec : JSON.stringify(spec), env, deps);
  return { code, output: JSON.parse(output), raw: output as string };
}

function refusal(spec: unknown): string {
  try {
    validateSpec(spec);
  } catch (error) {
    assert.ok(error instanceof Refused, String(error));
    return error.message;
  }
  return assert.fail(`the spec was accepted: ${JSON.stringify(spec)}`);
}

test('host pinning: only https on api.linkedin.com and www.linkedin.com is accepted', () => {
  for (const url of ['https://api.linkedin.com/v2/userinfo', 'https://www.linkedin.com/dms-uploads/x', 'https://API.LinkedIn.com/rest/posts']) {
    assert.match(validateSpec({ method: 'GET', url }).url.hostname, /^(api|www)\.linkedin\.com$/, url);
  }
  const refused = [
    'http://api.linkedin.com/v2/userinfo',
    'https://linkedin.com/x',
    'https://evil.example.com/rest/posts',
    'https://api.linkedin.com.evil.example.com/x',
    'https://api.linkedin.com@evil.example.com/x',
    'https://evil.example.com/?https://api.linkedin.com/',
    'https://api.linkedin.com:8443/x',
    'https://user:pw@api.linkedin.com/x',
    'https://api.linkedin.com./x',
    'ftp://api.linkedin.com/x',
    'file:///etc/passwd',
    'not a url',
  ];
  for (const url of refused) {
    assert.match(refusal({ method: 'GET', url }), /^(host not allowed|url must be https|url is not a valid URL)/, url);
  }
});

test('a refused host exits 2: no dialog, no request, and the token goes nowhere', async () => {
  const { deps, sent, asked } = world({ approve: true });
  const { code, output } = await helper({ ...POST, url: 'https://evil.example.com/rest/posts' }, deps);
  assert.equal(code, EXIT.refused);
  assert.match(output.error, /^host not allowed/);
  assert.equal(sent.length, 0);
  assert.equal(asked.length, 0);
});

test('a redirect is not followed: one request, sent with redirect manual, and the 302 comes back as it is', async () => {
  const { deps, sent } = world({
    respond: () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/steal' } }),
  });
  const { code, output } = await helper({ method: 'GET', url: 'https://api.linkedin.com/v2/userinfo' }, deps);
  assert.equal(code, EXIT.sent);
  assert.deepEqual(output, { status: 302, headers: { location: 'https://evil.example.com/steal' }, body: null });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].init.redirect, 'manual');
});

test('header allowlist: three names in any case, under their canonical spelling, and nothing else', () => {
  const clean = validateSpec({
    method: 'GET',
    url: 'https://api.linkedin.com/x',
    headers: { 'linkedin-version': '202610', 'X-RESTLI-PROTOCOL-VERSION': '2.0.0', 'content-type': 'application/json' },
  }).headers;
  assert.deepEqual(clean, { 'Linkedin-Version': '202610', 'X-Restli-Protocol-Version': '2.0.0', 'Content-Type': 'application/json' });

  const refused: Record<string, unknown>[] = [
    { 'X-RestLi-Method': 'DELETE' },
    { Cookie: 'li_at=x' },
    { Host: 'evil.example.com' },
    { 'Proxy-Authorization': 'Basic x' },
    { ' Content-Type': 'application/json' },
    { 'Content-Type': 'a', 'content-type': 'b' },
    { 'Linkedin-Version': 202610 },
    { 'Linkedin-Version': '202610\r\nAuthorization: Bearer x' },
  ];
  for (const headers of refused) {
    assert.match(refusal({ method: 'GET', url: 'https://api.linkedin.com/x', headers }), /^header /, JSON.stringify(headers));
  }
  assert.equal(refusal({ method: 'GET', url: 'https://api.linkedin.com/x', headers: ['a'] }), 'headers must be an object');
});

test('a caller-supplied Authorization is rejected in any case, and the helper adds its own', async () => {
  for (const name of ['Authorization', 'authorization', 'AUTHORIZATION', ' Authorization ']) {
    const { deps, sent } = world({ approve: true });
    const { code, output } = await helper({ ...POST, headers: { [name]: 'Bearer caller-chosen' } }, deps);
    assert.equal(code, EXIT.refused, name);
    assert.equal(output.error, 'Authorization is set by the helper. Remove it from the spec');
    assert.equal(sent.length, 0);
  }
  const { deps, sent } = world({ approve: true });
  await helper(POST, deps);
  assert.deepEqual(sent[0].init.headers, { ...POST.headers, Authorization: `Bearer ${TOKEN}` });
  assert.equal(sent[0].url, 'https://api.linkedin.com/rest/posts');
  assert.equal(sent[0].init.body, JSON.stringify(POST.json));
});

test('the gate: reads, upload registrations and file uploads pass; every other request needs approval', () => {
  const api = 'https://api.linkedin.com';
  const share = 'urn%3Ali%3Ashare%3A1';
  const table: [boolean, Record<string, unknown>][] = [
    [false, { method: 'GET', url: `${api}/v2/userinfo` }],
    [false, { method: 'GET', url: `${api}/rest/posts/${share}` }],
    [false, { method: 'POST', url: `${api}/rest/images?action=initializeUpload`, json: {} }],
    [false, { method: 'POST', url: `${api}/rest/documents?action=initializeUpload`, json: {} }],
    [false, { method: 'POST', url: `${api}/rest/videos?action=initializeUpload`, json: {} }],
    [false, { method: 'POST', url: `${api}/rest/videos?action=finalizeUpload`, json: {} }],
    [false, { method: 'POST', url: `${api}/v2/assets?action=registerUpload`, json: {} }],
    [false, { method: 'PUT', url: 'https://www.linkedin.com/dms-uploads/IMG1/uploaded-image/0?ut=x', file: '/tmp/a.png' }],
    [false, { method: 'PUT', url: `${api}/mediaUpload/IMG1/feedshare-uploadedImage/0?ca=x`, file: '/tmp/a.png' }],
    [true, { method: 'POST', url: `${api}/rest/posts`, json: {} }],
    [true, { method: 'DELETE', url: `${api}/rest/posts/${share}` }],
    [true, { method: 'POST', url: `${api}/rest/posts/${share}`, json: { patch: {} } }],
    [true, { method: 'PATCH', url: `${api}/rest/posts/${share}`, json: {} }],
    [true, { method: 'POST', url: `${api}/v2/socialActions/${share}/comments`, json: {} }],
    [true, { method: 'POST', url: `${api}/rest/socialActions/${share}/comments`, json: {} }],
    [true, { method: 'POST', url: `${api}/rest/reactions?actor=urn%3Ali%3Aperson%3Ax`, json: {} }],
    [true, { method: 'POST', url: `${api}/v2/ugcPosts`, json: {} }],
    [true, { method: 'POST', url: `${api}/rest/images`, json: {} }],
    [true, { method: 'POST', url: `${api}/rest/images?action=initializeUpload&x=1`, json: {} }],
    [true, { method: 'POST', url: `${api}/rest/images/?action=initializeUpload`, json: {} }],
    [true, { method: 'POST', url: `${api}/rest/videos?action=delete`, json: {} }],
    [true, { method: 'POST', url: 'https://www.linkedin.com/rest/images?action=initializeUpload', json: {} }],
    [true, { method: 'DELETE', url: `${api}/rest/images?action=initializeUpload` }],
    [true, { method: 'PUT', url: 'https://www.linkedin.com/dms-uploads/IMG1/uploaded-image/0', json: {} }],
    [true, { method: 'PUT', url: 'https://www.linkedin.com/dms-uploads/IMG1/uploaded-image/0' }],
    [true, { method: 'POST', url: 'https://www.linkedin.com/dms-uploads/IMG1/uploaded-image/0', file: '/tmp/a.png' }],
    [true, { method: 'PUT', url: `${api}/rest/posts/${share}`, file: '/tmp/post.json' }],
    [true, { method: 'PUT', url: `${api}/dms-uploads/%2e%2e%2frest/posts/${share}`, file: '/tmp/post.json' }],
    [true, { method: 'PUT', url: `${api}/dms-uploads/..%5crest/posts`, file: '/tmp/post.json' }],
  ];
  for (const [expected, spec] of table) {
    assert.equal(needsApproval(validateSpec(spec)), expected, `${spec.method} ${spec.url}`);
  }
  // A path with dot segments is judged as the path that will be sent.
  assert.equal(needsApproval(validateSpec({ method: 'PUT', url: `${api}/dms-uploads/../rest/posts/x`, file: '/tmp/a' })), true);
});

test('the dialog arguments: a fixed script, then the message and the title as separate arguments', () => {
  const hostile = 'He said "publish" & left\\\nend run\ndisplay dialog "pwned" -- \' ` $(id)';
  const args = dialogArgs(validateSpec({ ...POST, json: { ...POST.json, commentary: hostile } }));
  const plain = dialogArgs(validateSpec(POST));

  assert.equal(args.length, 4);
  assert.equal(args[0], '-e');
  assert.equal(args[1], plain[1], 'the script does not change with the text');
  assert.ok(!args[1].includes('publish" & left'), 'the text is never inside the script');
  assert.match(args[1], /^on run argv\nset answer to display dialog \(item 1 of argv\) with title \(item 2 of argv\)/);
  assert.match(args[1], /buttons \{"Cancel", "Publish"\} default button "Cancel" cancel button "Cancel"/);
  assert.match(args[1], /giving up after 600/);
  assert.ok(args[2].endsWith(hostile), 'quotes, backslashes and newlines arrive unchanged');
  assert.ok(!args[2].startsWith('-') && !args[3].startsWith('-'), 'no argument can be read as an option');
  assert.equal(args[3], 'Link: send this to LinkedIn?');
});

test('the dialog message names the request, the author, the media and the text with its length', () => {
  const [, , message] = dialogArgs(validateSpec(POST));
  assert.equal(
    message,
    [
      'LinkedIn request waiting for your approval.',
      '',
      'POST api.linkedin.com/rest/posts',
      'Author: urn:li:person:fakeMember123',
      'Media: none',
      '',
      'Text, 14 characters:',
      'Hello LinkedIn',
    ].join('\n'),
  );

  const withMedia = { ...POST.json, content: { media: { id: 'urn:li:document:DOC1', title: 'Deck' } } };
  assert.match(dialogArgs(validateSpec({ ...POST, json: withMedia }))[2], /\nMedia: attached \(urn:li:document:DOC1\)\n/);
});

test('a long text shows its first 700 characters and its full length; control characters are replaced', () => {
  const long = `${'é'.repeat(699)}🚀${'x'.repeat(300)}`;
  const [, , message] = dialogArgs(validateSpec({ ...POST, json: { ...POST.json, commentary: long } }));
  assert.match(message, /\nText, first 700 of 1000 characters:\n/);
  assert.ok(message.endsWith(`${'é'.repeat(699)}🚀`), 'cut on a character, never inside one');

  const [, , odd] = dialogArgs(validateSpec({ ...POST, json: { ...POST.json, commentary: 'a\u0000b\u001bc\td\ne' } }));
  assert.ok(odd.endsWith('a\uFFFDb\uFFFDc\td\ne'));
});

test('a comment shows message.text, its actor and the target URN; a delete shows its target', () => {
  const comment = validateSpec({
    method: 'POST',
    url: 'https://api.linkedin.com/v2/socialActions/urn%3Ali%3Ashare%3A7000000000000000001/comments',
    json: { actor: 'urn:li:person:fakeMember123', message: { text: 'Thanks for reading' } },
  });
  const message = dialogArgs(comment)[2];
  assert.match(message, /\nPOST api\.linkedin\.com\/v2\/socialActions\/urn:li:share:7000000000000000001\/comments\n/);
  assert.match(message, /\nTarget: urn:li:share:7000000000000000001\n/);
  assert.match(message, /\nAuthor: urn:li:person:fakeMember123\n/);
  assert.ok(message.endsWith('Text, 18 characters:\nThanks for reading'));

  const remove = dialogArgs(validateSpec({ method: 'DELETE', url: 'https://api.linkedin.com/rest/posts/urn%3Ali%3Ashare%3A7' }))[2];
  assert.ok(remove.endsWith('DELETE api.linkedin.com/rest/posts/urn:li:share:7\nTarget: urn:li:share:7'));
});

test('a write with no text shows its body, and a file shows its path and size', () => {
  const json = { root: 'urn:li:share:7', reactionType: 'LIKE' };
  const reaction = validateSpec({ method: 'POST', url: 'https://api.linkedin.com/rest/reactions', json });
  const body = JSON.stringify(json);
  assert.ok(dialogArgs(reaction)[2].endsWith(`Media: none\n\nBody, ${body.length} characters:\n${body}`));
  const put = validateSpec({ method: 'PUT', url: 'https://api.linkedin.com/rest/posts/x', file: '/tmp/post.json' });
  assert.ok(dialogArgs(put, 123)[2].endsWith('File: /tmp/post.json (123 bytes)'));
});

test('askHuman runs /usr/bin/osascript without a shell or the token, and only "Publish" is a yes', async () => {
  const answers: [Error | null, string, boolean][] = [
    [null, 'Publish\n', true],
    [null, 'Cancel\n', false],
    [null, 'gave up\n', false],
    [null, '', false],
    [null, 'publish', false],
    [new Error('execution error: User canceled. (-128)'), '', false],
    [new Error('spawn /usr/bin/osascript ENOENT'), 'Publish', false],
  ];
  for (const [error, stdout, expected] of answers) {
    const calls: unknown[][] = [];
    const fake = (file: string, args: string[], options: unknown, done: (error: Error | null, stdout: string) => void) => {
      calls.push([file, args, options]);
      done(error, stdout);
    };
    assert.equal(await askHuman(['-e', 'script', 'message', 'title'], fake as never), expected, JSON.stringify(stdout));
    assert.deepEqual(calls, [['/usr/bin/osascript', ['-e', 'script', 'message', 'title'], { env: {}, timeout: 630_000 }]]);
  }
});

test('not approved: exit 3, {"error":"not approved"}, and nothing is sent', async () => {
  const { deps, sent, asked } = world({ approve: false });
  const { code, raw } = await helper(POST, deps);
  assert.equal(code, 3);
  assert.equal(raw, '{"error":"not approved"}');
  assert.equal(sent.length, 0);
  assert.equal(asked.length, 1);
  assert.ok(asked[0][2].endsWith('Hello LinkedIn'), 'the dialog showed the text');
});

test('approved: the request is sent once, and the result carries the post URN', async () => {
  const { deps, sent, asked } = world({ approve: true });
  const { code, output } = await helper(POST, deps);
  assert.equal(code, 0);
  assert.deepEqual(output, { status: 201, headers: { 'x-restli-id': 'urn:li:share:1' }, body: null });
  assert.equal(sent.length, 1);
  assert.equal(asked.length, 1);
});

test('a read, an upload registration and a file upload are sent without a dialog', async () => {
  const registration = { value: { uploadUrl: 'https://www.linkedin.com/dms-uploads/IMG1/uploaded-image/0?ut=x', image: 'urn:li:image:IMG1' } };
  const { deps, sent, asked, read } = world({ file: 'png bytes', respond: () => Response.json(registration) });
  const specs = [
    { method: 'GET', url: 'https://api.linkedin.com/v2/userinfo' },
    { method: 'POST', url: 'https://api.linkedin.com/rest/images?action=initializeUpload', json: { initializeUploadRequest: { owner: 'urn:li:person:x' } } },
    { method: 'PUT', url: 'https://www.linkedin.com/dms-uploads/IMG1/uploaded-image/0?ut=x', file: '/tmp/chart.png' },
  ];
  for (const spec of specs) {
    const { code, output } = await helper(spec, deps);
    assert.equal(code, 0);
    assert.deepEqual(output.body, registration, 'the registration body, with its upload URL, is kept');
  }
  assert.equal(asked.length, 0);
  assert.equal(sent.length, 3);
  assert.deepEqual(read, ['/tmp/chart.png']);
  assert.equal(Buffer.from(sent[2].init.body as Uint8Array).toString(), 'png bytes');
  assert.deepEqual(sent[2].init.headers, { Authorization: `Bearer ${TOKEN}` });
  assert.equal(sent[1].init.headers['Content-Type'], 'application/json', 'a JSON body gets its content type');
});

test('the token never appears in the output, whatever LinkedIn or the network says', async () => {
  const echo = world({
    approve: true,
    respond: () =>
      Response.json(
        { message: `Invalid token ${TOKEN}`, [`key-${TOKEN}`]: [TOKEN, { nested: `Bearer ${TOKEN}` }] },
        { status: 401, headers: { location: `https://www.linkedin.com/?t=${TOKEN}`, 'x-li-uuid': TOKEN } },
      ),
  });
  const echoed = await helper(POST, echo.deps);
  assert.equal(echoed.code, 0);
  assert.ok(!echoed.raw.includes(TOKEN), echoed.raw);
  assert.equal(echoed.output.body.message, 'Invalid token REDACTED');
  assert.equal(echoed.output.headers.location, 'https://www.linkedin.com/?t=REDACTED');

  const down = world({ approve: true });
  down.deps.fetch = async () => {
    throw new TypeError(`fetch failed for Bearer ${TOKEN}`);
  };
  const failed = await helper(POST, down.deps);
  assert.equal(failed.code, 5);
  assert.equal(failed.raw, '{"error":"network error"}');

  for (const spec of [{ ...POST, [TOKEN]: 1 }, { ...POST, headers: { [TOKEN]: 'x' } }, `{"url": "${TOKEN}`]) {
    const refused = await helper(spec, world().deps);
    assert.equal(refused.code, 2);
    assert.ok(!refused.raw.includes(TOKEN), refused.raw);
  }
});

test('no token: exit 4 before any dialog or request', async () => {
  for (const env of [{}, { LINKEDIN_ACCESS_TOKEN: '' }, { LINKEDIN_ACCESS_TOKEN: ' \n' }]) {
    const { deps, sent, asked } = world({ approve: true });
    const { code, output } = await helper(POST, deps, env as Record<string, string>);
    assert.equal(code, 4);
    assert.equal(output.error, 'no token: LINKEDIN_ACCESS_TOKEN is not set');
    assert.equal(sent.length + asked.length, 0);
  }
});

test('a bad spec exits 2 with the reason, and nothing is sent', async () => {
  const bad: [unknown, RegExp][] = [
    ['not json', /^the spec is not valid JSON$/],
    ['', /^the spec is not valid JSON$/],
    [[POST], /^the spec must be a JSON object$/],
    [null, /^the spec must be a JSON object$/],
    [{ ...POST, shell: 'rm -rf' }, /^unknown spec field: shell$/],
    [{ ...POST, method: 'post' }, /^method must be one of GET, POST, PUT, PATCH, DELETE$/],
    [{ ...POST, method: 'CONNECT' }, /^method must be one of/],
    [{ ...POST, url: 42 }, /^url must be a string$/],
    [{ ...POST, file: '/tmp/a' }, /^give json or file, not both$/],
    [{ ...POST, json: 'text' }, /^json must be an object$/],
    [{ ...POST, json: [1] }, /^json must be an object$/],
    [{ method: 'PUT', url: POST.url, file: 'relative.png' }, /^file must be an absolute path$/],
    [{ method: 'GET', url: POST.url, json: {} }, /^a GET takes no body$/],
  ];
  for (const [spec, reason] of bad) {
    const { deps, sent, asked } = world({ approve: true });
    const { code, output } = await helper(spec, deps);
    assert.equal(code, 2, JSON.stringify(spec));
    assert.match(output.error, reason);
    assert.equal(sent.length + asked.length, 0);
  }
  const missing = await helper({ method: 'PUT', url: 'https://www.linkedin.com/dms-uploads/x', file: '/tmp/missing.png' }, world().deps);
  assert.equal(missing.code, 2);
  assert.equal(missing.output.error, 'file not found or not readable');
});

test('the result keeps the status, four headers at most, and the body as JSON, text or null', () => {
  const headers = new Headers({
    'X-RestLi-Id': 'urn:li:share:1',
    Location: '/rest/posts/1',
    'Content-Type': 'application/json',
    'X-LI-UUID': 'abc',
    'Set-Cookie': 'lidc=secret',
    'X-Li-Fabric': 'prod',
  });
  assert.deepEqual(shapeResult(201, headers, '{"a":1}'), {
    status: 201,
    headers: { 'x-restli-id': 'urn:li:share:1', location: '/rest/posts/1', 'content-type': 'application/json', 'x-li-uuid': 'abc' },
    body: { a: 1 },
  });
  assert.deepEqual(shapeResult(500, new Headers(), '<html>oops</html>'), { status: 500, headers: {}, body: '<html>oops</html>' });
  assert.deepEqual(shapeResult(204, new Headers(), ''), { status: 204, headers: {}, body: null });
});

test('run as a program: one JSON line on stdout, the documented exit code, and a silent stderr', () => {
  const start = (input: string, env: Record<string, string>) =>
    spawnSync(process.execPath, [HELPER], { input, env, encoding: 'utf8' });

  // Each of these stops before the dialog and before the network: no token, a refused host, a bad spec.
  const noToken = start(JSON.stringify({ method: 'GET', url: 'https://api.linkedin.com/v2/userinfo' }), {});
  assert.equal(noToken.status, 4);
  assert.equal(noToken.stdout, '{"error":"no token: LINKEDIN_ACCESS_TOKEN is not set"}\n');
  assert.equal(noToken.stderr, '');

  const refused = start(JSON.stringify({ ...POST, url: 'https://evil.example.com/' }), { LINKEDIN_ACCESS_TOKEN: TOKEN });
  assert.equal(refused.status, 2);
  assert.match(JSON.parse(refused.stdout).error, /^host not allowed/);
  assert.ok(!refused.stdout.includes(TOKEN) && refused.stderr === '');

  const garbage = start('{', { LINKEDIN_ACCESS_TOKEN: TOKEN });
  assert.equal(garbage.status, 2);
  assert.equal(garbage.stdout, '{"error":"the spec is not valid JSON"}\n');
});
