// SPDX-License-Identifier: Apache-2.0
// Two rules that keep the LinkedIn token away from the server's side. With the token in the server's own
// environment, no tool starts any process, live or dry. And every process the server does start, the helper command
// and each gate, gets five variables at most. The fixtures leave a marker file or list variable NAMES, never a value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Spec } from '../src/core.ts';
import { helperTransport } from '../src/linkedin.ts';
import { liveConfig, tempDir } from './fake-linkedin.ts';
import { call } from './rpc.ts';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const EXCLUDED = ['LINKEDIN_ACCESS_TOKEN', 'NODE_OPTIONS', 'BASH_ENV', 'ENV'];
const REFUSAL =
  "LINKEDIN_ACCESS_TOKEN is set in the Link server's environment. The server must not hold the token. Remove it and let the helper command supply the token (for example a key tool that starts link-linkedin).";
const TOOLS = [['link_status', {}], ['post_publish', { text: 'Hello' }]] as const;

test('every place in src/ that starts a process passes childEnv(env) as its environment', () => {
  const starts = /(?<![.\w])(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\(/;
  const sites: string[] = [];
  for (const file of readdirSync(SRC).sort()) {
    readFileSync(join(SRC, file), 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (starts.test(line)) sites.push(`${file}:${index + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(sites.map((site) => site.split(':')[0]), ['archive.ts', 'desk.ts', 'gates.ts', 'linkedin.ts'], sites.join('\n'));
  for (const site of sites) assert.match(site, /env: (\{ \.\.\.)?childEnv\(env\)/, site);
});

test('with the token in the server environment, no tool starts a process, live or in a dry run', async () => {
  const dir = tempDir();
  const gateMarker = join(dir, 'gate-ran');
  const helperMarker = join(dir, 'helper-ran');
  const config = {
    ...liveConfig(),
    gates: JSON.stringify([[process.execPath, fixture('leave-marker.mjs'), gateMarker]]),
    helper: JSON.stringify([process.execPath, fixture('leave-marker.mjs'), helperMarker]),
  };
  const withToken = { LINKEDIN_ACCESS_TOKEN: 'fake-token-for-tests', PATH: process.env.PATH, HOME: process.env.HOME };

  for (const dryRun of [false, true]) {
    for (const [name, args] of TOOLS) {
      const result = await call({ ...config, dryRun }, undefined, name, args, withToken);
      assert.equal(result.isError, true, `${name}, dry run ${dryRun}`);
      assert.equal(result.content[0].text, REFUSAL);
      assert.ok(!JSON.stringify(result).includes('fake-token-for-tests'));
    }
  }
  assert.equal(existsSync(gateMarker), false, 'no gate ran');
  assert.equal(existsSync(helperMarker), false, 'no helper command ran');

  // The same gate and helper do run once the token is gone, so the markers above were absent for that reason alone.
  for (const withoutToken of [{ PATH: process.env.PATH }, { PATH: process.env.PATH, LINKEDIN_ACCESS_TOKEN: '' }]) {
    await call(config, undefined, 'post_publish', { text: 'Hello' }, withoutToken);
  }
  assert.equal(existsSync(gateMarker), true);
  assert.equal(existsSync(helperMarker), true);
});

test('a gate and the helper command see none of the token, NODE_OPTIONS, BASH_ENV or ENV, even when the server has them', async () => {
  // The real environment of this process is the server's here, so a spawn that inherited it would show these names.
  const added: Record<string, string> = {
    NODE_OPTIONS: '--no-warnings',
    BASH_ENV: '/nonexistent/bash-env',
    ENV: '/nonexistent/env',
    LINK_TEST_OTHER: 'anything else the server has',
  };
  const before = Object.fromEntries(Object.keys(added).map((name) => [name, process.env[name]]));
  Object.assign(process.env, added);
  try {
    const config = { ...liveConfig(), dryRun: true, gates: JSON.stringify([[process.execPath, fixture('gate-env-names.mjs')]]) };
    const result = await call(config, undefined, 'post_publish', { text: 'Hello' });
    assert.notEqual(result.isError, true, result.content[0].text);
    const gateSaw = (JSON.parse(result.content[0].text).gate_warnings[0] as string).split(' ');

    const spec: Spec = { method: 'GET', url: 'https://api.linkedin.com/v2/userinfo', headers: {} };
    const helper = JSON.stringify([process.execPath, fixture('env-names.mjs')]);
    const helperSaw = (await helperTransport(helper)(spec)).body as string[];

    for (const [who, names] of [['a gate', gateSaw], ['the helper command', helperSaw]] as const) {
      for (const excluded of [...EXCLUDED, 'LINK_TEST_OTHER']) {
        assert.ok(!names.includes(excluded), `${who} saw ${excluded}`);
      }
      assert.ok(names.includes('PATH'), `${who} still gets PATH`);
    }
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
