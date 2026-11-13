// SPDX-License-Identifier: Apache-2.0
// One tool call's way to reach LinkedIn: live through a transport, or a dry run that only collects the specs. Also the
// pieces every request shares: the pinned API version, the headers, the error for a failed answer, and whoAmI, the
// signed-in member. Like linkedin.ts, it never calls fetch and never holds the token.
import apiVersion from '../quality/api-version.json' with { type: 'json' };
import { LinkError, type Config, type Spec, type Transport } from './core.ts';

/** The pinned `Linkedin-Version`, from quality/api-version.json (tests/version.test.ts watches its sunset). */
export const API_VERSION: string = apiVersion.version;

/** The host every API call goes to. */
export const API = 'https://api.linkedin.com';

/** What the member sees when LinkedIn answers 401. */
export const TOKEN_INVALID =
  "Token expired or invalid. Generate a new one in LinkedIn's Token Generator and store it (about 1 minute).";

/** `METHOD host/path` of a spec, for messages. No query string: an upload URL's query is a credential. */
export function where(spec: Spec): string {
  const { hostname, pathname } = new URL(spec.url);
  return `${spec.method} ${hostname}${pathname}`;
}

/** LinkedIn's answer to a call that succeeded. */
export interface Reply {
  /** The `x-restli-id` response header: the URN of what the call created. */
  id: string | null;
  json: unknown;
}

/** A spec as a dry run reports it: the spec itself, and the size of the file it uploads. */
type PlannedRequest = Spec & { bytes?: number };

/** One tool call's way to reach LinkedIn: live through the transport, or a dry run that only collects the specs. */
export interface Session {
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

/** Opens the session for one tool call: a dry run that collects specs, or a live one that sends them through `transport`. */
export function openSession(config: Config, transport: Transport): Session {
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
export function field(json: unknown, key: string): string | null {
  const value = (json as Record<string, unknown> | null)?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The headers Link sets on every api.linkedin.com call. The helper adds Authorization. */
export function apiHeaders(hasBody: boolean): Record<string, string> {
  return {
    'Linkedin-Version': API_VERSION,
    'X-Restli-Protocol-Version': '2.0.0',
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
  };
}

/** The signed-in member, from OpenID Connect's userinfo: the name, and the person URN a post names as its author. */
export async function whoAmI(session: Session): Promise<{ name: string | null; author: string }> {
  const { json } = await session.send({ method: 'GET', url: `${API}/v2/userinfo`, headers: apiHeaders(false) });
  const sub = field(json, 'sub');
  if (!sub) {
    throw new LinkError('LinkedIn returned no member id (sub). Generate the token with the openid and profile scopes.');
  }
  return { name: field(json, 'name'), author: `urn:li:person:${sub}` };
}

