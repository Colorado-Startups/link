// SPDX-License-Identifier: Apache-2.0
// A test gate that passes with a warning. The warning repeats what arrived on stdin, so a test can check the shape.
let input = '';
for await (const chunk of process.stdin) input += chunk;
const call = JSON.parse(input);
const additionalContext = `${call.hook_event_name} ${call.tool_name} text=${call.tool_input.text}`;
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext } }));
