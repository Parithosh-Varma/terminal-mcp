#!/usr/bin/env bash
#
# One command: local MCP server + optional Cloudflare relay agent, one lifecycle.
#
#   npm run up
#   RELAY_URL=https://other.workers.dev npm run up
#   PORT=9000 TERMINAL_MCP_ROOT=~/scratch npm run up
#
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

# No personal defaults baked in: the relay is configured per machine, either in
# the environment or in files next to the code.
URL="${RELAY_URL:-$(cat "$DIR/state/relay-url" 2>/dev/null || true)}"
TOKEN="${RELAY_TOKEN:-$(cat "$DIR/state/relay-token" 2>/dev/null || true)}"
PORT="${PORT:-8787}"

if [[ -n "$URL" && -z "$TOKEN" ]]; then
  echo "Relay URL is set but no token was found." >&2
  echo "Set RELAY_TOKEN or write it to $DIR/state/relay-token" >&2
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
  if [[ -n "${TERMINAL_MCP_ROOT:-}" ]]; then
    SERVER_ARGS=(--http --port "$PORT" --json-response --root "$TERMINAL_MCP_ROOT")
    echo "→ starting MCP server on :$PORT (shared root: $TERMINAL_MCP_ROOT)"
  else
    SERVER_ARGS=(--http --port "$PORT" --json-response)
    echo "→ starting MCP server on :$PORT (per session: sand1, sand2, …)"
  fi
  node dist/index.js "${SERVER_ARGS[@]}" &
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

if [[ -z "$URL" ]]; then
  echo "→ no relay configured — local only (http://127.0.0.1:$PORT/mcp)"
  echo "  set RELAY_URL=https://<worker>.workers.dev, or write it to state/relay-url"
else
  echo "→ connecting relay agent to $URL"
  # The token travels in the environment, never in argv, so it cannot show up in `ps`.
  RELAY_TOKEN="$TOKEN" node dist/relay-agent.js --url "$URL" &
  AGENT_PID=$!
fi

# If either side dies, take the whole thing down.
if [[ -n "$AGENT_PID" ]]; then
  while kill -0 "$AGENT_PID" 2>/dev/null; do
    if [[ -n "$SERVER_PID" ]] && ! kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "MCP server exited — shutting down." >&2
      exit 1
    fi
    sleep 1
  done
else
  [[ -n "$SERVER_PID" ]] && wait "$SERVER_PID"
fi
