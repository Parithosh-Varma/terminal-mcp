#!/usr/bin/env bash
#
# One command: local MCP server + Cloudflare relay agent, tied to one lifecycle.
#
#   npm run up
#   RELAY_URL=https://other.workers.dev npm run up
#   PORT=9000 TERMINAL_MCP_ROOT=~/scratch npm run up
#
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

URL="${RELAY_URL:-https://terminal-mcp-relay.parithosh.workers.dev}"
TOKEN="${RELAY_TOKEN:-$(cat "$DIR/state/relay-token" 2>/dev/null || true)}"
PORT="${PORT:-8787}"
ROOT="${TERMINAL_MCP_ROOT:-$DIR/workspace}"

if [[ -z "$TOKEN" ]]; then
  echo "No relay token. Set RELAY_TOKEN or write it to $DIR/state/relay-token" >&2
  exit 1
fi

if [[ ! -f "$DIR/dist/index.js" || ! -f "$DIR/dist/relay-agent.js" ]]; then
  echo "Build artifacts missing — running build first." >&2
  npm run build >/dev/null 2>&1 || { echo "build failed" >&2; exit 1; }
fi

SERVER_PID=""
AGENT_PID=""

cleanup() {
  trap - INT TERM EXIT
  echo
  echo "stopping…"
  [[ -n "$AGENT_PID" ]] && kill "$AGENT_PID" 2>/dev/null
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null
  wait "$AGENT_PID" 2>/dev/null
  wait "$SERVER_PID" 2>/dev/null
  exit 0
}
trap cleanup INT TERM EXIT

# Reuse an already-running local server rather than fighting over the port.
if curl -fsS --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "→ reusing MCP server already listening on :$PORT"
else
  echo "→ starting MCP server on :$PORT (root: $ROOT)"
  node dist/index.js --http --port "$PORT" --json-response --root "$ROOT" &
  SERVER_PID=$!

  for _ in $(seq 1 60); do
    curl -fsS --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
    sleep 0.2
  done

  if ! curl -fsS --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "MCP server failed to start." >&2
    exit 1
  fi
fi

echo "→ connecting relay agent to $URL"
node dist/relay-agent.js --url "$URL" --token "$TOKEN" &
AGENT_PID=$!

# If either side dies, take the whole thing down.
while kill -0 "$AGENT_PID" 2>/dev/null; do
  if [[ -n "$SERVER_PID" ]] && ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "MCP server exited — shutting down." >&2
    exit 1
  fi
  sleep 1
done
