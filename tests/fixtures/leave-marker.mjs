// SPDX-License-Identifier: Apache-2.0
// A stand-in gate or helper that proves it ran: it writes the file named by its first argument, then answers as a
// helper would for a userinfo read. As a gate that is a plain pass.
import { writeFileSync } from 'node:fs';

writeFileSync(process.argv[2], 'ran');
process.stdout.write(JSON.stringify({ status: 200, headers: {}, body: { sub: 'fakeMember123' } }));
