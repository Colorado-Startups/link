// SPDX-License-Identifier: Apache-2.0
// Every LinkedIn request Link makes, built here as a spec and handed to a transport. This file never calls fetch and
// never sends, stores or returns the token: the trusted helper (trusted/link-linkedin.mjs) adds the token, asks the
// member before each write, and sends. The helper gets the token from the process that starts it, in the supported
// setup a key tool. Two functions here keep the token away from the server's side: refuseToken, which every tool
// handler calls first and which only tests whether the server's environment holds a token, and childEnv, the minimal
// environment of every process the server starts. Request shapes follow learn.microsoft.com/linkedin (posts-api, images-api, documents-api,
// little-text-format and sign-in-with-linkedin-v2; view li-lms-2026-10, read 2026-11-12).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join } from 'node:path';
import apiVersion from '../quality/api-version.json' with { type: 'json' };
import type { Desk } from './desk.ts';
import { appendLedger, lastLedgerLines } from './ledger.ts';

/** The pinned `Linkedin-Version`, from quality/api-version.json (tests/version.test.ts watches its sunset). */
export const API_VERSION: string = apiVersion.version;

const API = 'https://api.linkedin.com';

const TOKEN_MISSING =
  "The LinkedIn helper had no usable token. Generate one in LinkedIn's Token Generator and store it (about 1 minute), and check that LINK_HELPER_CMD starts the helper through the key tool.";
const TOKEN_INVALID =
  "Token expired or invalid. Generate a new one in LinkedIn's Token Generator and store it (about 1 minute).";
const HELPER_EXAMPLE =
  'Set it to the command that starts the helper with the token, as a JSON array of strings, for example ["/bin/sh","-c","LINKEDIN_ACCESS_TOKEN=\\"$(/usr/bin/security find-generic-password -s link-linkedin -w)\\" exec /usr/local/bin/link-linkedin"].';
const TOKEN_IN_SERVER_ENV =
  "LINKEDIN_ACCESS_TOKEN is set in the Link server's environment. The server must not hold the token. Remove it and let the helper command supply the token (for example a key tool that starts link-linkedin).";
/** The only variables a process the server starts gets from it. Never the token, NODE_OPTIONS, BASH_ENV or ENV. */
const CHILD_ENV = ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR'];

/** A failure whose message is safe to show and names the fix. `status` is LinkedIn's HTTP status, when there was one. */
export class LinkError extends Error {
  status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** What the server reads from its environment. None of it is a secret. */
export interface Config {
  /** LINK_HELPER_CMD: the command that runs the trusted helper, as a JSON array of strings. */
  helper: string | undefined;
  /** LINK_DRY_RUN=1: no helper call and no ledger line. */
  dryRun: boolean;
  /** LINK_HOME, default ~/.link: the folder that holds the ledger. */
  home: string;
  /** LINK_GATES: the pre-publish gate commands, as a JSON array of argument arrays (src/gates.ts). */
  gates: string | undefined;
  /** LINK_GATE_TOOL_PREFIX, default mcp__link__: what a gate sees before the tool's name. */
  gatePrefix: string;
}

export function configFrom(env: Record<string, string | undefined>): Config {
  return {
    helper: env.LINK_HELPER_CMD || undefined,
    dryRun: env.LINK_DRY_RUN === '1',
    home: env.LINK_HOME || join(homedir(), '.link'),
    gates: env.LINK_GATES || undefined,
    gatePrefix: env.LINK_GATE_TOOL_PREFIX ?? 'mcp__link__',
  };
}

// A hashtag's #, left as it is, or any reserved character, captured to be escaped.
const LITTLE = /(?<!\S)#(?=[\p{L}\p{M}\p{N}]*\p{L})|([|{}@\[\]()<>#\\*_~])/gu;

/**
 * Plain text as LinkedIn's `little` text format, the format of a post's `commentary`. Each reserved character
 * (| { } @ [ ] ( ) < > # \ * _ ~) gets a backslash, which the format requires for it to be read as plain text. The one
 * exception is the # of a hashtag, sent as the format's HashtagElement (`#word`): a # at the start of the text or after
 * whitespace, followed by letters and digits with at least one letter. Every other # is escaped and shows as text.
 */
export function escapeLittle(text: string): string {
  return text.replace(LITTLE, (match: string, reserved?: string) => (reserved ? `\\${reserved}` : match));
}

/** One request for the helper: where it goes, the headers a caller may set, and a JSON body or a file to upload. */
export interface Spec {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  headers: Record<string, string>;
  json?: unknown;
  /** Absolute path of the file a PUT uploads. The helper reads it. */
  file?: string;
}

/** What the helper returns for a request it sent, whatever the HTTP status. */
export interface HelperResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** Sends one spec and returns LinkedIn's answer, or throws a LinkError when nothing came back. */
export type Transport = (spec: Spec) => Promise<HelperResult>;

/** `METHOD host/path` of a spec, for messages. No query string: an upload URL's query is a credential. */
function where(spec: Spec): string {
  const { hostname, pathname } = new URL(spec.url);
  return `${spec.method} ${hostname}${pathname}`;
}

/** The command in LINK_HELPER_CMD, or a LinkError that names the fix. */
function helperCommand(raw: string | undefined): string[] {
  if (!raw) throw new LinkError(`LINK_HELPER_CMD is not set. ${HELPER_EXAMPLE}`);
  let command: unknown = null;
  try {
    command = JSON.parse(raw);
  } catch {
    // Not JSON: the check below reports it.
  }
  // A program name, then its arguments. An argument may be empty; the program may not.
  const valid = Array.isArray(command) && command.every((part) => typeof part === 'string') && !!command[0];
  if (!valid) throw new LinkError(`LINK_HELPER_CMD is not valid. ${HELPER_EXAMPLE}`);
  return command as string[];
}

/**
 * The environment of every process the server starts, the helper command and each gate: the CHILD_ENV variables that
 * `env` (the server's own environment) has, and nothing else. tests/child-env.test.ts checks every call site in src/.
 */
export function childEnv(env: Record<string, string | undefined>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of CHILD_ENV) {
    const value = env[name];
    if (value !== undefined) kept[name] = value;
  }
  return kept;
}

/**
 * Throws when `env`, the server's own environment, holds a non-empty LINKEDIN_ACCESS_TOKEN. Every tool handler calls
 * it first, live and in a dry run, before a gate or the helper can start. It tests the value and does nothing else
 * with it.
 */
export function refuseToken(env: Record<string, string | undefined>): void {
  if (env.LINKEDIN_ACCESS_TOKEN) throw new LinkError(TOKEN_IN_SERVER_ENV);
}

/**
 * The default transport: runs the LINK_HELPER_CMD command without a shell, writes the spec to its stdin, and reads its
 * one JSON result from stdout. The helper's stderr is dropped, so nothing it prints there can reach a result or a log.
 * `env` is the server's own environment: the transport checks it with refuseToken too, so it starts nothing when used
 * on its own with the token present, and the command starts with childEnv(env), never with `env` itself.
 */
export function helperTransport(
  raw: string | undefined,
  env: Record<string, string | undefined> = process.env,
): Transport {
  return async (spec) => {
    refuseToken(env);
    const command = helperCommand(raw);
    const { code, stdout } = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'ignore'], env: childEnv(env) });
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => (out += chunk));
      child.on('error', () => resolve({ code: null, stdout: '' }));
      child.on('close', (exit) => resolve({ code: exit, stdout: out }));
      // A helper that exits before reading its input is reported by its exit code, not by this pipe.
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(spec));
    });
    let result: Partial<HelperResult> & { error?: unknown } = {};
    try {
      result = JSON.parse(stdout) ?? {};
    } catch {
      // No JSON on stdout: the exit code alone decides.
    }
    switch (code) {
      case 0:
        if (typeof result.status === 'number') {
          return { status: result.status, headers: result.headers ?? {}, body: result.body ?? null };
        }
        throw new LinkError(
          `The LinkedIn helper returned no result for ${where(spec)}. Check the profile before trying again.`,
        );
      case 2:
        throw new LinkError(
          `The LinkedIn helper refused ${where(spec)}: ${String(result.error ?? 'no reason given').slice(0, 300)}.`,
        );
      case 3:
        throw new LinkError('You cancelled in the approval dialog. Nothing was sent.');
      case 4:
        throw new LinkError(TOKEN_MISSING);
      case 5:
        throw new LinkError(
          `Could not reach LinkedIn (${where(spec)}). Check the network. If this was the post itself, check the profile before trying again.`,
        );
      case null:
        throw new LinkError('Could not start the LinkedIn helper. Check that the command in LINK_HELPER_CMD exists.');
      default:
        throw new LinkError(
          `The LinkedIn helper command failed (exit ${code}). Check LINK_HELPER_CMD and that the token is stored.`,
        );
    }
  };
}

interface Reply {
  /** The `x-restli-id` response header: the URN of what the call created. */
  id: string | null;
  json: unknown;
}

/** A spec as a dry run reports it: the spec itself, and the size of the file it uploads. */
type PlannedRequest = Spec & { bytes?: number };

/** One tool call's way to reach LinkedIn: live through the transport, or a dry run that only collects the specs. */
interface Session {
  /** `bytes` is the size of the file a spec uploads; only a dry run uses it. */
  send: (spec: Spec, bytes?: number) => Promise<Reply>;
  /** The requests a dry run collected; null when live. */
  planned: PlannedRequest[] | null;
}

/** What a dry run reads in place of LinkedIn's replies: named stand-ins for the values LinkedIn would return. */
const DRY_REPLY: Reply = {
  id: 'urn:li:share:ID_FROM_LINKEDIN',
  json: {
    sub: 'SUB_FROM_USERINFO',
    value: {
      uploadUrl: 'https://www.linkedin.com/dms-uploads/URL_FROM_INITIALIZE_UPLOAD',
      image: 'urn:li:image:ID_FROM_INITIALIZE_UPLOAD',
      document: 'urn:li:document:ID_FROM_INITIALIZE_UPLOAD',
    },
  },
};

function open(config: Config, transport: Transport): Session {
  if (config.dryRun) {
    const planned: PlannedRequest[] = [];
    return {
      planned,
      send: async (spec, bytes) => {
        planned.push(bytes === undefined ? spec : { ...spec, bytes });
        return DRY_REPLY;
      },
    };
  }
  return { planned: null, send: (spec) => sendLive(transport, spec) };
}

/** Sends one spec and turns any answer that is not a success into a LinkError that names the fix. */
async function sendLive(transport: Transport, spec: Spec): Promise<Reply> {
  const result = await transport(spec);
  if (result.status >= 200 && result.status < 300) {
    return { id: result.headers['x-restli-id'] ?? null, json: result.body };
  }
  if (result.status === 401) throw new LinkError(TOKEN_INVALID, 401);
  const said = (field(result.body, 'message') ?? 'nothing').slice(0, 300);
  if (result.status === 403 && new URL(spec.url).pathname.startsWith('/rest/')) {
    throw new LinkError(
      `LinkedIn refused ${where(spec)} (403). The app may lack access to this endpoint. LinkedIn said: ${said}`,
      403,
    );
  }
  throw new LinkError(`LinkedIn returned ${result.status} for ${where(spec)}. LinkedIn said: ${said}`, result.status);
}

/** A non-empty string field of a JSON object, or null. */
function field(json: unknown, key: string): string | null {
  const value = (json as Record<string, unknown> | null)?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The headers Link sets on every api.linkedin.com call. The helper adds Authorization. */
function apiHeaders(hasBody: boolean): Record<string, string> {
  return {
    'Linkedin-Version': API_VERSION,
    'X-Restli-Protocol-Version': '2.0.0',
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
  };
}

/** The signed-in member, from OpenID Connect's userinfo: the name, and the person URN a post names as its author. */
async function whoAmI(session: Session): Promise<{ name: string | null; author: string }> {
  const { json } = await session.send({ method: 'GET', url: `${API}/v2/userinfo`, headers: apiHeaders(false) });
  const sub = field(json, 'sub');
  if (!sub) {
    throw new LinkError('LinkedIn returned no member id (sub). Generate the token with the openid and profile scopes.');
  }
  return { name: field(json, 'name'), author: `urn:li:person:${sub}` };
}

type MediaKind = 'image' | 'document';

const MEDIA_KINDS: Record<string, MediaKind> = {
  '.pdf': 'document',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
};

interface Media {
  kind: MediaKind;
  path: string;
  /** The file's name, without its folder. */
  name: string;
  bytes: number;
}

async function checkMedia(path: string, title: string | undefined): Promise<Media> {
  if (!isAbsolute(path)) throw new LinkError(`media must be an absolute path. Got: ${path}`);
  const kind = MEDIA_KINDS[extname(path).toLowerCase()];
  if (!kind) throw new LinkError(`media must be a .pdf, .png, .jpg, .jpeg or .gif file. Got: ${basename(path)}`);
  if (kind === 'document' && !title?.trim()) throw new LinkError('title is required when media is a PDF.');
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new LinkError(`media file not found or not readable: ${path}`);
  return { kind, path, name: basename(path), bytes: info.size };
}

/** Registers an upload, PUTs the file to the URL LinkedIn returns, and returns the new image or document URN. */
async function upload(session: Session, author: string, media: Media): Promise<string> {
  const init = await session.send({
    method: 'POST',
    url: `${API}/rest/${media.kind}s?action=initializeUpload`,
    headers: apiHeaders(true),
    json: { initializeUploadRequest: { owner: author } },
  });
  const value = (init.json as { value?: unknown } | null)?.value;
  const uploadUrl = field(value, 'uploadUrl');
  const urn = field(value, media.kind);
  if (!uploadUrl || !urn) {
    throw new LinkError(`LinkedIn's reply to the ${media.kind} upload request had no upload URL or URN. Try again.`);
  }
  // The helper sends only to LinkedIn's own hosts, so an upload URL anywhere else is refused there.
  await session.send({ method: 'PUT', url: uploadUrl, headers: {}, file: media.path }, media.bytes);
  return urn;
}

/** What `post_publish` takes. */
export interface PostInput {
  text: string;
  media?: string;
  title?: string;
  visibility?: 'PUBLIC' | 'CONNECTIONS';
}

/**
 * Publishes one post as the signed-in member: text alone, or text with one image or one PDF. Live, it returns the post
 * URN and URL and appends a ledger line. In a dry run it returns the requests it would hand to the helper, in order,
 * and writes nothing.
 */
export async function publishPost(
  input: PostInput,
  config: Config,
  transport: Transport,
  now: Date = new Date(),
): Promise<Record<string, unknown>> {
  const media = input.media === undefined ? null : await checkMedia(input.media, input.title);
  const session = open(config, transport);
  const { author } = await whoAmI(session);
  // An image is attached by its URN alone; a document also carries the title LinkedIn shows on it.
  let content: { media: { id: string; title?: string } } | undefined;
  if (media) {
    const id = await upload(session, author, media);
    content = { media: media.kind === 'document' ? { id, title: input.title } : { id } };
  }
  const post = await session.send({
    method: 'POST',
    url: `${API}/rest/posts`,
    headers: apiHeaders(true),
    json: {
      author,
      commentary: escapeLittle(input.text),
      visibility: input.visibility ?? 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      ...(content ? { content } : {}),
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    },
  });
  if (session.planned) return { dry_run: true, requests: session.planned };
  if (!post.id) {
    throw new LinkError(
      'LinkedIn accepted the post but returned no post URN (x-restli-id). Check the profile before posting again.',
    );
  }
  const kind = media?.kind ?? 'text';
  const url = `https://www.linkedin.com/feed/update/${post.id}/`;
  // The post is live by now, so a ledger that cannot be written is reported, never thrown: an error here would invite
  // a second post.
  let ledger = 'written';
  try {
    appendLedger(config.home, {
      time: now.toISOString(),
      kind,
      urn: post.id,
      url,
      chars: input.text.length,
      sha256: createHash('sha256').update(input.text).digest('hex'),
      media: media?.name ?? null,
    });
  } catch {
    ledger = `not written: could not append to ${join(config.home, 'ledger.jsonl')}`;
  }
  return { urn: post.id, url, kind, chars: input.text.length, ledger };
}

const POST = /urn:li:(?:share|ugcPost|activity):\d+/;
const COMMENT = /^urn:li:comment:\((?:urn:li:)?(activity|ugcPost|share):(\d+),(\d+)\)$/;

/**
 * The comment a LinkedIn comment link points at, as the parent for a reply, or undefined when `link` names no comment.
 * "Copy link to comment" gives `…/feed/update/urn:li:activity:P?commentUrn=urn:li:comment:(activity:P,C)`; a reply's
 * link adds `&replyUrn=urn:li:comment:(activity:P,R)`. `link` arrives URL-decoded. Returns the URN in the short form
 * COMMENT accepts; commentCreate expands it. Throws a LinkError when the link names a comment it cannot use.
 */
export function commentFromLink(link: string): string | undefined {
  const query = link.includes('?') ? new URLSearchParams(link.slice(link.indexOf('?') + 1)) : undefined;
  const comment = query?.get('commentUrn') ?? undefined;
  const reply = query?.get('replyUrn') ?? undefined;
  // LinkedIn nests one level: a reply's link still names its top-level comment, and that is the only valid parent.
  const parent = comment ?? reply;
  if (parent === undefined) return undefined;
  const m = COMMENT.exec(parent.trim());
  if (!m) throw new LinkError('The link names a comment Link cannot read. Pass the comment URN as parent instead.');
  const post = POST.exec(link.slice(0, link.indexOf('?')))?.[0];
  if (post && post !== `urn:li:${m[1]}:${m[2]}`) throw new LinkError('The link names a comment on another post.');
  return parent;
}

/** What `comment_create` takes: the post (URN or URL), the text, and the comment it answers, if any. */
export interface CommentInput {
  post: string;
  text: string;
  parent?: string;
}

/**
 * Comments on a post, or replies under one comment, as the signed-in member, through the older
 * /v2/socialActions/{urn}/comments endpoint (comments-api, li-lms-2026-10, read 2026-11-13). This app's products list
 * no comments endpoint, so on a 403 it writes LINK_HOME/comments-api-refused and from then on, like that call, puts
 * the text on the clipboard and opens the post for the member to paste. The text is plain: comments take no little
 * format. Live, a sent comment appends a ledger line; a dry run returns the requests and touches nothing.
 */
export async function commentCreate(input: CommentInput, config: Config, transport: Transport, desk: Desk, now: Date = new Date()) {
  let decoded = input.post;
  try {
    decoded = decodeURIComponent(input.post);
  } catch {
    // Not encoded: used as it is.
  }
  const post = POST.exec(decoded)?.[0];
  if (!post) throw new LinkError('post must be a post URN (urn:li:activity:, urn:li:share: or urn:li:ugcPost: and digits) or a post URL that holds one.');
  let parent: string | undefined;
  // A comment or reply link carries its own parent, so one pasted link is enough to answer a comment.
  const named = input.parent ?? commentFromLink(decoded);
  if (named !== undefined) {
    const m = COMMENT.exec(named.trim());
    if (!m) throw new LinkError('parent must be a comment URN, for example urn:li:comment:(urn:li:activity:123,456).');
    parent = `urn:li:comment:(urn:li:${m[1]}:${m[2]},${m[3]})`;
  }
  const url = `https://www.linkedin.com/feed/update/${post}/`;
  const refused = join(config.home, 'comments-api-refused');
  const byHand = async (reason: string) => {
    if (!config.dryRun) {
      await desk.copy(input.text);
      await desk.open(url);
    }
    return { sent: false, reason, opened: url, next: 'Press Cmd+V in the comment box, read it, press Enter.' };
  };
  if (existsSync(refused)) return byHand(`LinkedIn refused the comments endpoint before. Delete ${refused} to try it again.`);
  const session = open(config, transport);
  const { author } = await whoAmI(session);
  let sent: Reply;
  try {
    sent = await session.send({
      method: 'POST',
      url: `${API}/v2/socialActions/${encodeURIComponent(parent ?? post)}/comments`,
      headers: apiHeaders(true),
      json: { actor: author, object: post, message: { text: input.text }, ...(parent ? { parentComment: parent } : {}) },
    });
  } catch (error) {
    if (!(error instanceof LinkError) || error.status !== 403) throw error;
    mkdirSync(config.home, { recursive: true, mode: 0o700 });
    writeFileSync(refused, `${now.toISOString()}\n`, { mode: 0o600 });
    return byHand('LinkedIn refused the comments endpoint for this app (403).');
  }
  if (session.planned) return { dry_run: true, requests: session.planned };
  let ledger = 'written';
  try {
    appendLedger(config.home, {
      time: now.toISOString(), kind: 'comment', urn: sent.id ?? '', url, chars: input.text.length,
      sha256: createHash('sha256').update(input.text).digest('hex'), media: null,
    });
  } catch {
    ledger = `not written: could not append to ${join(config.home, 'ledger.jsonl')}`;
  }
  return { sent: true, comment: sent.id, url, ledger };
}

/**
 * What `link_status` returns: who the token signs in as, whether the token works (null in a dry run, which does not
 * check), the pinned API version, whether dry-run is on, and the last 5 ledger lines. A missing or rejected token is
 * an answer, not an error. Any other failure is thrown.
 */
export async function linkStatus(config: Config, transport: Transport): Promise<Record<string, unknown>> {
  const fixed = { api_version: API_VERSION, dry_run: config.dryRun, ledger: lastLedgerLines(config.home, 5) };
  const nobody = { name: null, author: null };
  try {
    const session = open(config, transport);
    const me = await whoAmI(session);
    if (session.planned) return { ...nobody, token_works: null, ...fixed, requests: session.planned };
    return { ...me, token_works: true, ...fixed };
  } catch (error) {
    if (!(error instanceof LinkError) || ![TOKEN_MISSING, TOKEN_INVALID].includes(error.message)) throw error;
    return { ...nobody, token_works: false, problem: error.message, ...fixed };
  }
}
