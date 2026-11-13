// SPDX-License-Identifier: Apache-2.0
// A stand-in helper that answers with the NAMES of its own environment variables, sorted. It never prints a value.
process.stdout.write(JSON.stringify({ status: 200, headers: {}, body: Object.keys(process.env).sort() }));
