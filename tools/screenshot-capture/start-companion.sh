#!/usr/bin/env sh
# Starts the Local Capture Companion on macOS or Linux.
# Run: ./start-companion.sh --portal=<address> --code=<pairing code>
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node.js 20 or later from https://nodejs.org and run this again."
  exit 1
fi

if [ ! -d node_modules/playwright ]; then
  echo "Installing the companion's browser tools. This happens once."
  npm install --no-audit --no-fund || { echo "npm install did not finish. Check your internet connection and run this again."; exit 1; }
fi

if ! node companion.mjs --check >/dev/null 2>&1; then
  echo "Installing the Chromium browser. This happens once."
  npx playwright install chromium
fi

exec node companion.mjs "$@"
