#!/bin/sh
# xneog installer — https://cli.xneog.com
# Installs the xneog CLI globally via npm (Node.js >= 20 required).
set -e

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
err()  { printf '\033[31m%s\033[0m\n' "$1" >&2; }

bold "xneog installer"

if ! command -v node >/dev/null 2>&1; then
  err "Node.js not found. Install Node.js >= 20 first: https://nodejs.org"
  exit 1
fi

MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$MAJOR" -lt 20 ]; then
  err "Node.js >= 20 required (found $(node -v)). Upgrade: https://nodejs.org"
  exit 1
fi

echo "installing @xneog/cli via npm..."
npm install -g github:gomes007-alt/xneog-cli

bold "done — try it:"
echo "  xneog login    # point it at your xneog-agentd"
echo "  xneog          # start a session in the current directory"
echo ""
echo "docs: https://github.com/gomes007-alt/xneog-cli"
