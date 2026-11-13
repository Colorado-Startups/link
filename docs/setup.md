# Set up Link

Each person who runs Link creates their own LinkedIn app and is the developer under LinkedIn's API Terms. Link is not affiliated with LinkedIn or Anthropic. macOS only (the approval dialog uses `osascript`).

| Step | Do |
| --- | --- |
| 1. Install | Node 26 or newer. `git clone https://github.com/Colorado-Startups/link && cd link && npm ci` |
| 2. Install the helper | `sudo ./install.sh`. It installs 2 root-owned files, uses your Node path, and prints both SHA-256 values. It never touches a token |
| 3. Create a LinkedIn app | In the [LinkedIn Developer Portal](https://www.linkedin.com/developers/apps), create an app. Name it anything without "LinkedIn" or "In". Link it to a Page you administer |
| 4. Add products | On the app's Products tab, add **Share on LinkedIn** and **Sign In with LinkedIn using OpenID Connect** |
| 5. Make a token | Developer Portal, Token Generator: pick `openid profile w_member_social`, then generate. Tokens last 60 days; repeat step 6 to renew |
| 6. Store it | `security add-generic-password -U -s link-linkedin -a "$USER" -w` (prompts, input hidden) |
| 7. Add to your MCP host | Put the example below in `.mcp.json`, with the real path of `src/server.ts` |
| 8. Check | Ask Claude to call `link_status`. Rehearse with `LINK_DRY_RUN=1` before a live post |

```json
{
  "mcpServers": {
    "link": {
      "command": "node",
      "args": ["/absolute/path/to/link/src/server.ts"],
      "env": {
        "LINK_HELPER_CMD": "[\"/bin/sh\",\"-c\",\"LINKEDIN_ACCESS_TOKEN=\\\"$(/usr/bin/security find-generic-password -s link-linkedin -w)\\\" exec /usr/local/bin/link-linkedin\"]"
      }
    }
  }
}
```

| Variable | Needed | Meaning |
| --- | --- | --- |
| `LINK_HELPER_CMD` | Yes, for live calls | JSON array that starts the helper with the token (above) |
| `LINK_HOME` | No | Data folder. Default `~/.link` |
| `LINK_DRY_RUN` | No | `1` calls no helper and writes no ledger line |
| `LINK_GATES` | No | JSON array of pre-publish gate commands. See the [README](../README.md) |
| `LINK_GATE_TOOL_PREFIX` | No | Tool-name prefix gates see. Default `mcp__link__` |

The token never enters the MCP server: the shell above reads it from the Keychain and hands it straight to the helper. Do not set `LINKEDIN_ACCESS_TOKEN` in the server's own environment: every tool call then returns an error.
