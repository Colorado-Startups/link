// SPDX-License-Identifier: Apache-2.0
// Stands in for the helper when a test runs a copy of the launcher. It reports what the launcher handed it, and never
// prints a value from its environment: the token is compared here, against the file `expected` beside this script,
// and only true or false goes out. It also leaves the file `ran` beside itself, so a test can tell it started.
import { fstatSync, readFileSync, writeFileSync } from 'node:fs';

const beside = (name) => new URL(`./${name}`, import.meta.url);
writeFileSync(beside('ran'), 'ran');

let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += chunk;

let fd3 = 'closed';
try {
  const info = fstatSync(3);
  fd3 = info.isFIFO() ? 'pipe' : info.isFile() ? 'file' : 'other';
} catch {
  // fd 3 is not open.
}

process.stdout.write(
  JSON.stringify({
    tokenArrived: process.env.LINKEDIN_ACCESS_TOKEN === readFileSync(beside('expected'), 'utf8'),
    names: Object.keys(process.env).sort(),
    stdin,
    args: process.argv.slice(2),
    nodeOptions: process.execArgv,
    fd3,
  }),
);
