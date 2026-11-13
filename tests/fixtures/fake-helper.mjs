// SPDX-License-Identifier: Apache-2.0
// A contract double of the trusted helper (trusted/link-linkedin.mjs) for tests/e2e.test.ts. Like the real helper it
// reads ONE spec on stdin and writes ONE result line on stdout, exit 0, as after LinkedIn answered. First it appends
// the spec as one JSON line to the file after --log: an argument, since the server gives a helper a minimal
// environment. No network, no token, no dialog. Every value is made up.
import { appendFileSync } from 'node:fs';

const log = process.argv[process.argv.indexOf('--log') + 1];
let input = '';
for await (const chunk of process.stdin) input += chunk;
const spec = JSON.parse(input);
appendFileSync(log, `${JSON.stringify(spec)}\n`);
const ROUTES = {
  'GET /v2/userinfo': { status: 200, headers: {}, body: { sub: 'fakeE2eMember', name: 'Fake Member' } },
  'POST /rest/posts': { status: 201, headers: { 'x-restli-id': 'urn:li:share:7000000000000000042' }, body: null },
};
const route = ROUTES[`${spec.method} ${new URL(spec.url).pathname}`];
const result = route ?? { status: 404, headers: {}, body: { message: 'the fake helper has no route for this' } };
process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
