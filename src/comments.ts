// SPDX-License-Identifier: Apache-2.0
// comment_create: a comment on a post, or a reply under one comment, as the signed-in member, through the older
// /v2/socialActions endpoint. Where LinkedIn refuses that endpoint, the text goes on the clipboard for the member to paste.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LinkError, type Config, type Transport } from './core.ts';
import type { Desk } from './desk.ts';
import { recordLedger } from './ledger.ts';
import { API, apiHeaders, openSession, whoAmI, type Reply } from './session.ts';

const POST = /urn:li:(?:share|ugcPost|activity):\d+/;
const COMMENT = /^urn:li:comment:\((?:urn:li:)?(activity|ugcPost|share):(\d+),(\d+)\)$/;

/**
 * The comment a LinkedIn comment link points at, as the parent for a reply, or undefined when `link` names no comment.
 * "Copy link to comment" gives `…/feed/update/urn:li:activity:P?commentUrn=urn:li:comment:(activity:P,C)`; a reply's
 * link adds `&replyUrn=urn:li:comment:(activity:P,R)`. `link` arrives URL-decoded. Returns the URN in the short form
 * COMMENT accepts; commentCreate expands it. Throws a LinkError when the link names a comment it cannot use.
 */
function commentFromLink(link: string): string | undefined {
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

/** `text` URL-decoded, or as it is when it is not encoded. */
function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The post URN and the parent comment URN (undefined for a top-level comment) that `input` names. */
function targetOf(input: CommentInput): { post: string; parent: string | undefined } {
  const link = decoded(input.post);
  const post = POST.exec(link)?.[0];
  if (!post) throw new LinkError('post must be a post URN (urn:li:activity:, urn:li:share: or urn:li:ugcPost: and digits) or a post URL that holds one.');
  // A comment or reply link carries its own parent, so one pasted link is enough to answer a comment.
  const named = input.parent ?? commentFromLink(link);
  if (named === undefined) return { post, parent: undefined };
  const m = COMMENT.exec(named.trim());
  if (!m) throw new LinkError('parent must be a comment URN, for example urn:li:comment:(urn:li:activity:123,456).');
  return { post, parent: `urn:li:comment:(urn:li:${m[1]}:${m[2]},${m[3]})` };
}

/** The answer when the comment is left to the member: its text on the clipboard and the post open, unless it is a dry run. */
async function byHand(config: Config, desk: Desk, text: string, url: string, reason: string) {
  if (!config.dryRun) {
    await desk.copy(text);
    await desk.open(url);
  }
  return { sent: false, reason, opened: url, next: 'Press Cmd+V in the comment box, read it, press Enter.' };
}

/**
 * Comments on a post, or replies under one comment, as the signed-in member, through the older
 * /v2/socialActions/{urn}/comments endpoint (comments-api, li-lms-2026-10, read 2026-11-13). This app's products list
 * no comments endpoint, so on a 403 it writes LINK_HOME/comments-api-refused and from then on, like that call, puts
 * the text on the clipboard and opens the post for the member to paste. The text is plain: comments take no little
 * format. Live, a sent comment appends a ledger line; a dry run returns the requests and touches nothing.
 */
export async function commentCreate(input: CommentInput, config: Config, transport: Transport, desk: Desk, now: Date = new Date()) {
  const { post, parent } = targetOf(input);
  const url = `https://www.linkedin.com/feed/update/${post}/`;
  const refused = join(config.home, 'comments-api-refused');
  if (existsSync(refused)) {
    return byHand(config, desk, input.text, url, `LinkedIn refused the comments endpoint before. Delete ${refused} to try it again.`);
  }
  const session = openSession(config, transport);
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
    return byHand(config, desk, input.text, url, 'LinkedIn refused the comments endpoint for this app (403).');
  }
  if (session.planned) return { dry_run: true, requests: session.planned };
  const entry = { time: now.toISOString(), kind: 'comment' as const, urn: sent.id ?? '', url, media: null };
  const ledger = recordLedger(config.home, entry, input.text);
  return { sent: true, comment: sent.id, url, ledger };
}
