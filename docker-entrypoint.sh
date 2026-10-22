#!/bin/sh
# One container, two processes: the dashboard/backend (Next.js) and Perry's
# runner, which drives the engine (OpenCode) that answers turns.
set -e

export HOSTNAME=0.0.0.0
HOME_DIR="${PERRY_HOME:-/tmp/perry}"
mkdir -p "$HOME_DIR"
# A restarted container is one runner: the previous process's lock outlives it.
rm -f "$HOME_DIR"/runner-*.lock

node_modules/.bin/next start -p "${PORT:-7377}" &
server=$!

# Start the runner only once the server answers: it signs in on its first call,
# and a server still booting looks the same as one that is down.
(
  until curl -sf "http://127.0.0.1:${PORT:-7377}/api/backend/http/health" >/dev/null; do sleep 1; done
  # A dropped connection must not leave the bot with no hands: bring it back.
  while true; do
    bun runner/index.ts --dir "$HOME_DIR/workspace" || true
    sleep 2
  done
) &
runner=$!

# Render sends TERM on deploy/restart: take the engine down with the server.
trap 'kill "$server" "$runner" 2>/dev/null; wait "$server" "$runner" 2>/dev/null' TERM INT

wait "$server"
