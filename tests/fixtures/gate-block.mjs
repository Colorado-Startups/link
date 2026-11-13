// SPDX-License-Identifier: Apache-2.0
// A test gate that blocks: exit 2, with the reason on stderr.
process.stderr.write('The halt file is present: posting is paused.\n');
process.exit(2);
