// SPDX-License-Identifier: Apache-2.0
// Test helper: one JSON-RPC request to a fresh Link server, answered in process through the SDK's request handler.
import assert from 'node:assert/strict';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { Config, Transport } from '../src/linkedin.ts';
import type { Desk } from '../src/desk.ts';
import { buildServer } from '../src/server.ts';

export interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

type Env = Record<string, string | undefined>;

/**
 * `transport` undefined builds the server with its default transport, the helper in `config.helper`. `env` stands for
 * the server's own environment; undefined is the real one.
 */
export async function rpc(config: Config, transport: Transport | undefined, method: string, params: Record<string, unknown> = {}, env?: Env, desk?: Desk) {
  const request = new Request('https://link.example.test/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await (await createMcpHandler(() => buildServer(config, { transport, env, desk })).fetch(request)).text();
  const data = text.split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(data ? data.slice('data: '.length) : text);
}

/** Calls one tool and returns its result, after checking it came back as a result and not a JSON-RPC error. */
export async function call(config: Config, transport: Transport | undefined, name: string, args: Record<string, unknown> = {}, env?: Env, desk?: Desk) {
  const out = await rpc(config, transport, 'tools/call', { name, arguments: args }, env, desk);
  assert.equal(out.error, undefined, `a tool result, not a protocol error: ${JSON.stringify(out.error)}`);
  return out.result as ToolResult;
}
