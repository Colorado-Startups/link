// SPDX-License-Identifier: Apache-2.0
// A test gate that passes and reports the NAMES of its own environment variables as its warning. Never a value.
const additionalContext = Object.keys(process.env).sort().join(' ');
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext } }));
