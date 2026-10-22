#!/bin/sh
# One container, two processes: the dashboard/backend (Next.js) and Perry's
# runner, which drives the engine (OpenCode) that answers turns. The runner
# waits for the server to write runner.json, so either order is fine.
set -e

export HOSTNAME=0.0.0.0
mkdir -p "${PERRY_HOME:-/tmp/perry}"
# A restarted container is one runner: the previous process's lock outlives it.
rm -f "${PERRY_HOME:-/tmp/perry}"/runner-*.lock

node_modules/.bin/next start -p "${PORT:-7377}" &
server=$!

bun runner/index.ts --dir "${PERRY_HOME:-/tmp/perry}/workspace" &
runner=$!

# Render sends TERM on deploy/restart: take the engine down with the server.
trap 'kill "$server" "$runner" 2>/dev/null; wait "$server" "$runner" 2>/dev/null' TERM INT

wait "$server"
