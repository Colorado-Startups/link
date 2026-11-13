// SPDX-License-Identifier: Apache-2.0
// Pre-publish gates: the commands in LINK_GATES, run in order before a LinkedIn write tool acts, live or in a dry
// run. Each gets the tool call on stdin in the Claude Code PreToolUse hook shape. Exit 2 blocks. Exit 0 passes and
// may warn. Anything else (another exit code, the 60 second limit, a command that will not start) is "could not
// verify" and never blocks: a gate script decides when to block, and a broken one must not. A gate starts with the
// minimal environment (childEnv), never with the server's own, and the tool handler has already refused to run if the
// server's environment holds the LinkedIn token (refuseToken).
import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { childEnv, LinkError } from './linkedin.ts';

const LIMIT_MS = 60_000;
const EXAMPLE = '[["python3","/abs/check.py","--hook"]]';

/** What the gates add to a tool result. */
export interface GateNotes {
  gate_warnings?: string[];
  gate_could_not_verify?: string[];
}

interface GateRun {
  code: number | null;
  stdout: string;
  stderr: string;
  reason: string;
}

function runGate(argv: string[], input: string, env: Record<string, string | undefined>): Promise<GateRun> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: 'pipe', timeout: LIMIT_MS, env: childEnv(env) });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', () => resolve({ code: null, stdout, stderr, reason: 'could not start' }));
    child.on('close', (code, signal) =>
      resolve({ code, stdout, stderr, reason: signal ? `stopped by ${signal} (the limit is 60 seconds)` : `exit ${code}` }),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/**
 * Runs every gate. Returns their warnings and could-not-verify notes, or throws a LinkError when one blocks. `env` is
 * the server's own environment, from which each gate gets childEnv(env) only.
 */
export async function runGates(
  raw: string | undefined,
  toolName: string,
  toolInput: unknown,
  env: Record<string, string | undefined>,
): Promise<GateNotes> {
  let gates: unknown = [];
  try {
    if (raw) gates = JSON.parse(raw);
  } catch {
    gates = null;
  }
  // A program name, then its arguments. An argument may be empty; the program may not.
  const isArgv = (argv: unknown) => Array.isArray(argv) && argv.every((part) => typeof part === 'string') && !!argv[0];
  if (!Array.isArray(gates) || !gates.every(isArgv)) {
    throw new LinkError(`LINK_GATES is not valid. Set it to a JSON array of argument arrays, for example ${EXAMPLE}.`);
  }
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput });
  const notes: GateNotes = {};
  for (const argv of gates as string[][]) {
    const { code, stdout, stderr, reason } = await runGate(argv, input, env);
    if (code === 2) {
      throw new LinkError(`Blocked by a pre-publish gate. Nothing was sent. ${stderr.trim().slice(0, 2000)}`);
    }
    if (code !== 0) {
      (notes.gate_could_not_verify ??= []).push(`${basename(argv[1] ?? argv[0])}: ${reason}`);
      continue;
    }
    let warning: unknown;
    try {
      warning = JSON.parse(stdout)?.hookSpecificOutput?.additionalContext;
    } catch {
      // No JSON on stdout: a plain pass.
    }
    if (typeof warning === 'string' && warning !== '') (notes.gate_warnings ??= []).push(warning);
  }
  return notes;
}
