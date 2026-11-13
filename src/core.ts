// SPDX-License-Identifier: Apache-2.0
// What every other module shares and nothing here imports from src/: the LinkError type, the Config the server reads
// from its environment, childEnv (the minimal environment of every process the server starts) and the shapes of a
// request to the helper and its result. A leaf, so no module cycles back through it.
import { homedir } from 'node:os';
import { join } from 'node:path';

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

/** The Config an environment describes: each LINK_ variable, with the defaults for the ones that are unset. */
export function configFrom(env: Record<string, string | undefined>): Config {
  return {
    helper: env.LINK_HELPER_CMD || undefined,
    dryRun: env.LINK_DRY_RUN === '1',
    home: env.LINK_HOME || join(homedir(), '.link'),
    gates: env.LINK_GATES || undefined,
    gatePrefix: env.LINK_GATE_TOOL_PREFIX ?? 'mcp__link__',
  };
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

