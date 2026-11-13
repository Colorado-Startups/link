// SPDX-License-Identifier: Apache-2.0
// A fake LinkedIn for tests: a transport that records each spec the server hands over and answers from a route
// table, as the trusted helper would after sending it. Nothing here, and no test, reaches the network. Every value
// is made up.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config, HelperResult, Spec, Transport } from '../src/linkedin.ts';

export const SUB = 'fakeMember123';
export const AUTHOR = `urn:li:person:${SUB}`;
export const POST_URN = 'urn:li:share:7000000000000000001';
export const IMAGE_UPLOAD_URL = 'https://www.linkedin.com/dms-uploads/IMG1/uploaded-image/0?ut=fake1';
export const DOCUMENT_UPLOAD_URL = 'https://www.linkedin.com/dms-uploads/DOC1/ads-uploadedDocument/0?ut=fake2';

type Route = (spec: Spec) => HelperResult;

/** A helper result: LinkedIn's status, the headers the helper passes on, and the parsed body. */
export function reply(status: number, body: unknown = null, headers: Record<string, string> = {}): HelperResult {
  return { status, headers, body };
}

/** LinkedIn's documented happy path, keyed by method and path prefix. */
const ROUTES: Record<string, Route> = {
  'GET /v2/userinfo': () => reply(200, { sub: SUB, name: 'Test Member' }),
  'POST /rest/images': () => reply(200, { value: { uploadUrl: IMAGE_UPLOAD_URL, image: 'urn:li:image:IMG1' } }),
  'POST /rest/documents': () => reply(200, { value: { uploadUrl: DOCUMENT_UPLOAD_URL, document: 'urn:li:document:DOC1' } }),
  'PUT /dms-uploads/': () => reply(201),
  'POST /rest/posts': () => reply(201, null, { 'x-restli-id': POST_URN }),
};

/** A transport that answers as LinkedIn does, with `overrides` replacing routes, and the specs it received. */
export function fakeLinkedIn(overrides: Record<string, Route> = {}): { transport: Transport; calls: Spec[] } {
  const routes = { ...ROUTES, ...overrides };
  const calls: Spec[] = [];
  const transport: Transport = async (spec) => {
    calls.push(spec);
    const target = `${spec.method} ${new URL(spec.url).pathname}`;
    const key = Object.keys(routes).find((route) => target.startsWith(route));
    if (!key) throw new Error(`the fake LinkedIn has no route for ${target}`);
    return routes[key](spec);
  };
  return { transport, calls };
}

/** A fresh temporary folder. */
export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'link-test-'));
}

/** A live config with a fresh LINK_HOME that does not exist yet, no helper command and no gates. */
export function liveConfig(): Config {
  return { helper: undefined, dryRun: false, home: join(tempDir(), 'home'), gates: undefined, gatePrefix: 'mcp__link__' };
}

/** Writes a small file with the given name into a fresh folder and returns its absolute path. */
export function mediaFile(name: string, content = 'fake media bytes'): string {
  const path = join(tempDir(), name);
  writeFileSync(path, content);
  return path;
}
