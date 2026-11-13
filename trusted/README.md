# The trusted helper

`link-linkedin` is the one program that uses the LinkedIn token and shows the approval dialog. It receives the token from the process that starts it.

| Question | Answer |
| --- | --- |
| What it does | Reads one request spec as JSON on stdin. Adds the token. Asks the member before any write. Sends the request. Writes one JSON result on stdout |
| Why it is separate | A session can edit any file in a repo checkout. So code there that receives a token can be changed to leak it, or to skip the approval |
| What makes it trusted | It is installed as root-owned files, outside any checkout. Node built-ins only, and no import from `src/` |
| Where the token comes from | The environment of the process that starts it: `LINKEDIN_ACCESS_TOKEN`. The helper cannot tell who that process is |
| The supported setup | A key tool starts it. The token goes from the Keychain to the key tool to the helper, and never enters the MCP server |
| What the server enforces | While the token is in the server's own environment, every tool call returns an error and starts no process. Every process the server starts, the helper command and each gate, gets `HOME`, `USER`, `LOGNAME`, `PATH` and `TMPDIR` only ([tests/child-env.test.ts](../tests/child-env.test.ts)) |

## Install

Installing needs an administrator: both targets are root-owned.

| Source | Target | Owner | Mode |
| --- | --- | --- | --- |
| [link-linkedin](link-linkedin) | `/usr/local/bin/link-linkedin` | root | 755 |
| [link-linkedin.mjs](link-linkedin.mjs) | `/usr/local/lib/link/link-linkedin.mjs` | root | 644 |

| The launcher | Does | So |
| --- | --- | --- |
| Checks the token's shape | Exits 4 when the token is empty or has a character outside `A-Za-z0-9._:+/=-` | The one-line env file it writes cannot be misread |
| Starts Node with `env -i` and `HOME` only | `NODE_OPTIONS`, `PATH` and exported shell functions never reach Node | Nothing in the caller's environment can change what Node runs |
| Hands Node the token through a pipe on fd 3 | A here-document holds one line: the variable's name, `=`, the token. Node reads it with `--env-file=/dev/fd/3` | The token is never on a command line. There, `ps` would show it to every local process |

## Contract

| Part | Shape |
| --- | --- |
| Spec (stdin) | `{ "method": "GET\|POST\|PUT\|PATCH\|DELETE", "url": "https://...", "headers": {...}, "json": {...} }`, or `"file": "/absolute/path"` in place of `json` |
| Result (stdout) | `{ "status": 201, "headers": {...}, "body": ... }`. Headers: `x-restli-id`, `location`, `content-type`, `x-li-uuid` only |
| Failure (stdout) | `{ "error": "..." }` |

| Exit code | Meaning |
| --- | --- |
| 0 | Sent. The HTTP status is in the result |
| 2 | Bad spec, refused host or refused header |
| 3 | Not approved. Nothing was sent |
| 4 | No token in the environment, or a token the launcher refuses for its shape |
| 5 | Network error |

## Guarantees

Each row names the test that proves it: in [tests/helper.test.ts](../tests/helper.test.ts) for the helper, and in [tests/launcher.test.ts](../tests/launcher.test.ts) for the launcher.

| Guarantee | Test |
| --- | --- |
| The token goes only to `https://api.linkedin.com` and `https://www.linkedin.com` | "host pinning", "a refused host exits 2" |
| A redirect is never followed | "a redirect is not followed" |
| A caller sets 3 headers at most, and never `Authorization` | "header allowlist", "a caller-supplied Authorization is rejected" |
| Every write needs a click on Publish. Cancel is the default, and 600 seconds without an answer is a no | "the gate", "not approved", "askHuman runs /usr/bin/osascript" |
| Only reads, upload registrations and file uploads to an upload URL skip the dialog | "the gate", "a read, an upload registration and a file upload" |
| The text of a post cannot change the dialog's script: it is an argument, never part of the script | "the dialog arguments" |
| The token never appears on stdout or stderr | "the token never appears in the output", "run as a program" |
| The token is never on a command line | Launcher: "the token variable is in no command's arguments", "the launcher hands Node the token through a pipe" |
| Node starts with `HOME` and the token, and nothing else from the caller. macOS adds `__CF_USER_TEXT_ENCODING` to every process itself | Launcher: "the launcher hands Node the token through a pipe" |
| The request spec on stdin reaches the helper unchanged | Launcher: "the launcher hands Node the token through a pipe" |
| An empty or misshapen token starts nothing | Launcher: "an empty token, or one with a character outside the key shape" |
| The launcher is the reviewed five lines, and executable | Launcher: "the launcher is the reviewed five lines" |

## Limits

| Limit | Detail |
| --- | --- |
| The real dialog | No test shows it. Tests fake `osascript`. The first live post proves it |
| What the dialog shows | The first 700 characters of the text, then the full length |
| File uploads | An upload sends any file the account can read to LinkedIn without a dialog. A file becomes visible only through a post, and a post needs approval |
| Platform | macOS. Where `/usr/bin/osascript` is missing, every write is refused |
