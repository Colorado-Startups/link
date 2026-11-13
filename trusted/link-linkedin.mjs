// SPDX-License-Identifier: Apache-2.0
// link-linkedin: the one program that holds the LinkedIn token. It reads ONE request spec as JSON on stdin, adds the
// token, asks the member in a macOS dialog before any write, sends the request to LinkedIn, and writes ONE JSON result
// on stdout. The Link server and every other caller stay outside: they never see the token and cannot skip the dialog.
//
// It is installed as root-owned files (trusted/README.md), so a session that can edit a repo checkout cannot change it.
// Node built-ins only, and no import from the rest of the repo.
//
//   spec    { "method": "GET|POST|PUT|PATCH|DELETE", "url": "https://...", "headers": {...},
//             "json": {...} or "file": "/absolute/path" }
//   result  { "status": 201, "headers": { "x-restli-id": "..." }, "body": <parsed JSON, text or null> }
//   failure { "error": "..." }
//   exit    0 sent (any HTTP status), 2 bad spec or refused host or header, 3 not approved, 4 no token, 5 network error
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT = { sent: 0, refused: 2, notApproved: 3, noToken: 4, network: 5 };

const OSASCRIPT = '/usr/bin/osascript';
const SPEC_FIELDS = ['method', 'url', 'headers', 'json', 'file'];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
/** The only hosts the token may go to. */
const HOSTS = ['api.linkedin.com', 'www.linkedin.com'];
/** The only headers a caller may set. Authorization is the helper's alone. */
const CALLER_HEADERS = ['Linkedin-Version', 'X-Restli-Protocol-Version', 'Content-Type'];
/** The only response headers a caller gets back. */
const RESULT_HEADERS = ['x-restli-id', 'location', 'content-type', 'x-li-uuid'];
/** Upload registrations on api.linkedin.com: they publish nothing, so they need no approval. */
const REGISTRATIONS = [
  '/rest/images?action=initializeUpload',
  '/rest/documents?action=initializeUpload',
  '/rest/videos?action=initializeUpload',
  '/rest/videos?action=finalizeUpload',
  '/v2/assets?action=registerUpload',
];
/** Where LinkedIn's upload URLs point. A PUT of a file to one of these publishes nothing, so it needs no approval. */
const UPLOAD_PATHS = ['/dms-uploads/', '/mediaUpload/'];
/** An encoded slash, backslash or dot in a path: a server could read it as another path, so it never skips the gate. */
const ENCODED_PATH_PART = /%(2f|5c|2e)/i;
/** How much of the text the dialog shows, in characters. */
const SHOWN = 700;

/** A spec the helper will not send. Its message is safe to print. */
export class Refused extends Error {}

/**
 * Checks a parsed spec and returns it cleaned: the method, the URL as a URL object, the caller's headers under their
 * canonical names, and the json or file body. Throws Refused for anything else.
 */
export function validateSpec(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) throw new Refused('the spec must be a JSON object');
  const unknown = Object.keys(spec).find((key) => !SPEC_FIELDS.includes(key));
  if (unknown !== undefined) throw new Refused(`unknown spec field: ${unknown.slice(0, 40)}`);
  const { method, url, json, file } = spec;
  if (!METHODS.includes(method)) throw new Refused(`method must be one of ${METHODS.join(', ')}`);
  if (typeof url !== 'string') throw new Refused('url must be a string');
  let target;
  try {
    target = new URL(url);
  } catch {
    throw new Refused('url is not a valid URL');
  }
  if (target.protocol !== 'https:') throw new Refused('url must be https');
  if (!HOSTS.includes(target.hostname) || target.port !== '' || target.username !== '' || target.password !== '') {
    throw new Refused(`host not allowed. The helper sends only to ${HOSTS.join(' and ')}`);
  }
  if (json !== undefined && file !== undefined) throw new Refused('give json or file, not both');
  if (json !== undefined && (json === null || typeof json !== 'object' || Array.isArray(json))) {
    throw new Refused('json must be an object');
  }
  if (file !== undefined && (typeof file !== 'string' || !isAbsolute(file))) {
    throw new Refused('file must be an absolute path');
  }
  if (method === 'GET' && (json !== undefined || file !== undefined)) throw new Refused('a GET takes no body');
  return { method, url: target, headers: cleanHeaders(spec.headers ?? {}), json, file };
}

function cleanHeaders(headers) {
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new Refused('headers must be an object');
  }
  const clean = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.trim().toLowerCase();
    if (lower === 'authorization') throw new Refused('Authorization is set by the helper. Remove it from the spec');
    const allowed = CALLER_HEADERS.find((header) => header.toLowerCase() === lower);
    if (allowed === undefined || name !== name.trim()) {
      throw new Refused(`header not allowed: ${name.slice(0, 40)}. A caller may set ${CALLER_HEADERS.join(', ')}`);
    }
    if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Refused(`header ${allowed} must be a one-line string`);
    if (allowed in clean) throw new Refused(`header ${allowed} is given twice`);
    clean[allowed] = value;
  }
  return clean;
}

/**
 * The gate, default deny: whether a validated spec needs the member's approval. A GET reads. An upload registration
 * and the PUT of a file to an upload URL publish nothing. Every other request is a write and needs a yes.
 */
export function needsApproval(spec) {
  const { method, url, file } = spec;
  if (method === 'GET') return false;
  const uploadPath = UPLOAD_PATHS.some((prefix) => url.pathname.startsWith(prefix)) && !ENCODED_PATH_PART.test(url.pathname);
  if (method === 'PUT' && file !== undefined && uploadPath) return false;
  if (method === 'POST' && url.hostname === 'api.linkedin.com' && REGISTRATIONS.includes(url.pathname + url.search)) {
    return false;
  }
  return true;
}

// The whole script is fixed. The text and the title arrive as arguments (argv), never inside the script, so nothing
// in a post can end the string or add a statement. Cancel is the default button, and no answer in 600 seconds is no.
const DIALOG_SCRIPT = `on run argv
set answer to display dialog (item 1 of argv) with title (item 2 of argv) buttons {"Cancel", "Publish"} default button "Cancel" cancel button "Cancel" with icon caution giving up after 600
if gave up of answer then return "gave up"
return button returned of answer
end run`;
const DIALOG_TITLE = 'Link: send this to LinkedIn?';

/** Text made safe to show and to pass as an argument: control characters other than newline and tab are replaced. */
function shown(value, limit = 300) {
  const text = Array.from(String(value)).slice(0, limit).join('');
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '\uFFFD');
}

function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value !== '');
}

/**
 * The arguments for /usr/bin/osascript that show the approval dialog for a validated spec: the fixed script, then the
 * message, then the title. The message names the request, the author, the target URN, any media, and the text that
 * will be sent: a post's `commentary` or a comment's `message.text`, its first 700 characters and its full length.
 * `fileBytes` is the size of the file a spec uploads.
 */
export function dialogArgs(spec, fileBytes) {
  const { method, url, json, file } = spec;
  let path = url.pathname;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    // A path that does not decode is shown as it is.
  }
  const lines = ['LinkedIn request waiting for your approval.', '', `${method} ${url.hostname}${shown(path + url.search)}`];
  const target = /urn:li:[A-Za-z]+:[^/?,)]+/.exec(path)?.[0];
  if (target !== undefined) lines.push(`Target: ${shown(target)}`);
  if (json !== undefined) {
    const author = firstString(json.author, json.actor);
    if (author !== undefined) lines.push(`Author: ${shown(author)}`);
    const media = json.content === undefined ? 'none' : `attached (${shown(firstString(json.content?.media?.id) ?? 'see body')})`;
    lines.push(`Media: ${media}`);
    const text = firstString(json.commentary, json.message?.text);
    const body = text ?? JSON.stringify(json);
    const length = Array.from(body).length;
    const label = text === undefined ? 'Body' : 'Text';
    lines.push('', length > SHOWN ? `${label}, first ${SHOWN} of ${length} characters:` : `${label}, ${length} characters:`);
    lines.push(shown(body, SHOWN));
  }
  if (file !== undefined) lines.push(`File: ${shown(file)} (${fileBytes ?? 'unknown'} bytes)`);
  return ['-e', DIALOG_SCRIPT, lines.join('\n'), DIALOG_TITLE];
}

/**
 * Shows the dialog and resolves true only when the member clicked Publish. Cancel, a timeout, a missing osascript or
 * any error is no. osascript runs by absolute path, without a shell, and without the token in its environment.
 */
export function askHuman(args, run = execFile) {
  return new Promise((resolve) => {
    run(OSASCRIPT, args, { env: {}, timeout: 630_000 }, (error, stdout) => {
      resolve(!error && String(stdout).trim() === 'Publish');
    });
  });
}

/** A value with every occurrence of the token replaced, in strings and keys at any depth. */
function scrub(value, token) {
  if (token === '') return value;
  if (typeof value === 'string') return value.replaceAll(token, 'REDACTED');
  if (Array.isArray(value)) return value.map((item) => scrub(item, token));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [scrub(key, token), scrub(item, token)]));
  }
  return value;
}

/**
 * The result a caller gets for a request that was sent: the status, four response headers at most, and the body as
 * parsed JSON, as text, or null when empty. `headers` is the response's Headers object.
 */
export function shapeResult(status, headers, text) {
  const kept = {};
  for (const name of RESULT_HEADERS) {
    const value = headers.get(name);
    if (value !== null) kept[name] = value;
  }
  let body = null;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status, headers: kept, body };
}

/**
 * Handles one request: `input` is the spec as JSON text, `env` holds LINKEDIN_ACCESS_TOKEN, and `deps` are the three
 * things that touch the world: `fetch`, `readFile` and `approve(dialogArguments)`. Returns the exit code and the one
 * line of JSON for stdout, with the token scrubbed from it. It never throws for a bad spec, a refusal or a failure.
 */
export async function run(input, env, deps) {
  const token = (env.LINKEDIN_ACCESS_TOKEN ?? '').trim();
  const done = (code, value) => ({ code, output: JSON.stringify(scrub(value, token)) });

  let spec;
  try {
    spec = validateSpec(JSON.parse(input));
  } catch (error) {
    return done(EXIT.refused, { error: error instanceof Refused ? error.message : 'the spec is not valid JSON' });
  }
  if (token === '') return done(EXIT.noToken, { error: 'no token: LINKEDIN_ACCESS_TOKEN is not set' });

  let body;
  if (spec.file !== undefined) {
    try {
      body = await deps.readFile(spec.file);
    } catch {
      return done(EXIT.refused, { error: 'file not found or not readable' });
    }
  } else if (spec.json !== undefined) {
    body = JSON.stringify(spec.json);
  }

  if (needsApproval(spec) && !(await deps.approve(dialogArgs(spec, body?.byteLength)))) {
    return done(EXIT.notApproved, { error: 'not approved' });
  }

  const headers = { ...spec.headers, Authorization: `Bearer ${token}` };
  if (spec.json !== undefined && headers['Content-Type'] === undefined) headers['Content-Type'] = 'application/json';
  let response;
  let text;
  try {
    // Redirects are never followed, so the token cannot be carried to another host.
    response = await deps.fetch(spec.url.href, { method: spec.method, headers, body, redirect: 'manual' });
    text = await response.text();
  } catch {
    return done(EXIT.network, { error: 'network error' });
  }
  return done(EXIT.sent, shapeResult(response.status, response.headers, text));
}

async function main() {
  let code = 1;
  let output = JSON.stringify({ error: 'the helper failed unexpectedly' });
  try {
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) input += chunk;
    ({ code, output } = await run(input, process.env, { fetch, readFile, approve: (args) => askHuman(args) }));
  } catch {
    // An unexpected failure prints the fixed line above and nothing of its own, so no detail can leak.
  }
  process.stdout.write(`${output}\n`, () => process.exit(code));
}

// Run only when executed as a program. Tests import the parts above.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
