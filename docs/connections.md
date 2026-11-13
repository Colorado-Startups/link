# Rate and clean up your connections

Link rates your connections from your own LinkedIn data export (Settings, Data privacy, Get a copy of your data). It reads local files only, never talks to LinkedIn, and removes nothing. Tools: `archive_load`, `connections_list`, `connections_mark`, `connections_next`, `connections_check`.

| # | Rule, first match wins | Tier, reason |
|---|---|---|
| 1 | Your mark | KEEP or REMOVE, `override` |
| 2 | You started a 1:1 thread, or sent 2 or more messages | PROTECTED, `thread` |
| 3 | Endorsement or recommendation, either way | PROTECTED, `endorsed` |
| 4 | On a keep list | PROTECTED, `keeplist` |
| 5 | Connected within 90 days, no pitch | PROTECTED, `new` |
| 6 | They wrote first with a pitch phrase, you never replied | REMOVE, `pitch` |
| 7 | Sales, lead-generation, recruiter or MLM words in the position | REMOVE, `sales` |
| 8 | Mission words or places in position or company | KEEP, `mission` |
| 9 | No position and no company | REMOVE, `empty` |
| 10 | No message either way, connected over a year | REMOVE, `low` |
| 11 | Anything else | REVIEW, `other` |

Default word lists: `rules/rater.default.json`. `LINK_RATER` names a JSON overlay: lists are added, numbers replace. Mission words, `places` and `keep_files` (CSV with a `url`, `email`, or `first_name` and `last_name` column) belong in your overlay.

| Days with removals since the last warning | Per day | Per sitting |
|---|---|---|
| 1 to 3 | 25 | 25 |
| 4 to 7 | 50 | 25 |
| 8 on | 80 | 40 |

A sitting ends after 30 minutes idle. `connections_next` waits 15 to 45 seconds after the last removal. A `warning` mark writes `LINK_HALT_FILE`; while it exists, `connections_next`, `post_publish`, `comment_create` and `reply_open` refuse until you delete it.

| Variable | Use |
|---|---|
| `LINK_HOME` | Folder for `connections.json`, `removals.json`, `archive/` (default `~/.link`) |
| `LINK_RATER`, `LINK_HALT_FILE` | Overlay JSON path, halt file path |
| `LINK_OWNER_URL`, `LINK_GAP` | Your profile URL if messages do not show you; wait range, default `15-45` |

To remove a connection yourself: open the profile, More, Remove connection. The other person is not notified. Endorsements and recommendations between you are deleted.
