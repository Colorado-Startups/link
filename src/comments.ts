// SPDX-License-Identifier: Apache-2.0
// comment_create: a comment on a post, or a reply under one comment, as the signed-in member, through the older
// /v2/socialActions endpoint. Where LinkedIn refuses that endpoint, the text goes on the clipboard for the member to paste.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LinkError, type Config, type Transport } from './core.ts';
import type { Desk } from './desk.ts';
import { appendLedger } from './ledger.ts';
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

