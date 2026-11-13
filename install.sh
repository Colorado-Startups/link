#!/bin/sh
# Installs the reviewed trusted helper as root-owned files. Run: sudo ./install.sh. Never touches a token.
set -eu
MIN=26
[ "$(id -u)" = 0 ] || { echo "Run with sudo: sudo ./install.sh" >&2; exit 1; }
[ "$(uname)" = Darwin ] || { echo "Link supports macOS only." >&2; exit 1; }
cd "$(dirname "$0")"
U="${SUDO_USER:-}"; [ -n "$U" ] && [ "$U" != root ] || { echo "Run it with sudo from your own account." >&2; exit 1; }
NODE="$(su -l "$U" -c 'command -v node' 2>/dev/null | tail -n 1)"
[ -n "$NODE" ] && [ -x "$NODE" ] || { echo "Node $MIN or newer not found for $U. Install it, then rerun." >&2; exit 1; }
case "$NODE" in *[!A-Za-z0-9._/+-]*) echo "Unsupported characters in the Node path: $NODE" >&2; exit 1 ;; esac
V="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$V" -ge "$MIN" ] || { echo "Node $V is older than $MIN. Upgrade it, then rerun." >&2; exit 1; }
# The helper runs this Node with the token. If you can write it or its folder (Homebrew in your own account, nvm,
# Volta), any process of yours could swap it and read the token, so refuse (issue #2).
REAL="$(/usr/bin/realpath "$NODE")"
if sudo -u "$U" test -w "$REAL" || sudo -u "$U" test -w "$(dirname "$REAL")"; then
  echo "Your account can write $REAL. Install Node from nodejs.org (root-owned), then rerun." >&2; exit 1
fi
install -d -o root -g wheel -m 755 /usr/local/lib/link /usr/local/bin
install -o root -g wheel -m 644 trusted/link-linkedin.mjs /usr/local/lib/link/link-linkedin.mjs
install -o root -g wheel -m 755 trusted/link-token /usr/local/bin/link-token
if [ "$NODE" = /opt/homebrew/bin/node ]; then
  install -o root -g wheel -m 755 trusted/link-linkedin /usr/local/bin/link-linkedin
else
  sed "s#/opt/homebrew/bin/node#$NODE#" trusted/link-linkedin > /usr/local/bin/link-linkedin
  chown root:wheel /usr/local/bin/link-linkedin; chmod 755 /usr/local/bin/link-linkedin
fi
shasum -a 256 /usr/local/lib/link/link-linkedin.mjs /usr/local/bin/link-linkedin /usr/local/bin/link-token
echo "Installed with Node at $NODE"
