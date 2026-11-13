// SPDX-License-Identifier: Apache-2.0
// A test gate that fails on its own: exit 3 is neither a pass nor a block.
process.stderr.write('could not read the rules file\n');
process.exit(3);
