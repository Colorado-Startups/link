---
name: bump-pins
description: Moves the Git Crafter engine pin and the Claudius pack pin to their latest release tags, in one pull request. Use when either repo publishes a new release.
compatibility: Requires gh signed in and git.
---

# Bump pins

Dependabot bumps action pins (`uses: ...@<sha> # vX`). It never reads `quality/config.json`, so the pack pin moves here.

| Step | Do |
|---|---|
| 1 | Latest tags: `gh release view -R SoulCraft-Org/git-crafter --json tagName` and the same for `Colorado-Startups/claudius` |
| 2 | Each tag's commit: `git ls-remote https://github.com/<owner>/<repo> refs/tags/<tag>^{}` (no `^{}` line: use the plain tag line) |
| 3 | Replace the engine SHA and its `# vX` comment in every workflow that names it. `ci.yml` and `pages.yml` pin one SHA |
| 4 | Replace `Colorado-Startups/claudius@<sha>` in `quality/config.json` `packs` |
| 5 | Read the release notes between the old and new tags for a renamed or removed tab id. A removed id stops the build (exit 2) and names its new tab |
| 6 | Open one pull request. Its pages run is the check: no exit 2, no new "not measured" row |

Never pin a branch name, a short SHA or an untagged commit.
