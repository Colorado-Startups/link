// SPDX-License-Identifier: Apache-2.0
// Member data never enters this public repo: no real profile links, no LinkedIn exports. Failures name the file only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const BAD_PATH = /(^|\/)(Connections|messages|Invitations)\.csv$|\.zip$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|ico|icns|pdf)$/i;
const PROFILE = /linkedin\.com\/in\/(?!example-)[^\s"'`)\]/?]/i;

test('no tracked export file', () => {
  assert.deepEqual(files.filter((f) => BAD_PATH.test(f)), []);
});

test('no real profile link in any tracked file', () => {
  const hits = files.filter((f) => !IMAGE.test(f) && PROFILE.test(readFileSync(f, 'utf8')));
  assert.deepEqual(hits, [], 'files with a non-example profile link (text not shown)');
});
