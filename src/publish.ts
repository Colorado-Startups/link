// SPDX-License-Identifier: Apache-2.0
// post_publish: one post as the signed-in member, text alone or with one image or one PDF, and the little text format
// its commentary needs. Live, a post appends a ledger line; a dry run returns the requests and writes nothing.
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';
import { LinkError, type Config, type Transport } from './core.ts';
import { appendLedger } from './ledger.ts';
import { API, apiHeaders, field, openSession, whoAmI, type Session } from './session.ts';

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
  const session = openSession(config, transport);
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

