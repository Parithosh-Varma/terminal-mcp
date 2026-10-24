#!/usr/bin/env node
/**
 * Mac-side agent for the Cloudflare Worker relay.
 *
 * Dials OUT to the Worker over WebSocket, receives MCP HTTP requests and
 * forwards them to the local terminal-mcp HTTP server. No inbound ports.
 *
 *   node dist/relay-agent.js --url https://terminal-mcp.you.workers.dev --token SECRET
 */
import { parseArgs } from "./config.js";

interface RelayRequest {
  type: "request";
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
}

const HELP = `terminal-mcp relay agent

Usage:
  node dist/relay-agent.js --url <worker-url> --token <secret> [options]

Options:
  --url <url>        Worker base URL, e.g. https://terminal-mcp.you.workers.dev
  --token <secret>   Shared RELAY_TOKEN configured on the Worker
  --local <url>      Local MCP server (default http://127.0.0.1:8787)
  --verbose          Log every forwarded request

Environment:
  RELAY_URL, RELAY_TOKEN, RELAY_LOCAL
`;

const args = parseArgs();

if (args.help || args.h) {
  process.stdout.write(HELP);
  process.exit(0);
}

const rawUrl = (args.url as string | undefined) ?? process.env.RELAY_URL;
const token = (args.token as string | undefined) ?? process.env.RELAY_TOKEN;
const local = ((args.local as string | undefined) ?? process.env.RELAY_LOCAL ?? "http://127.0.0.1:8787").replace(
  /\/$/,
  "",
);
const verbose = args.verbose === true || process.env.RELAY_VERBOSE === "1";

if (!rawUrl || !token) {
  process.stderr.write("Missing --url or --token.\n\n" + HELP);
  process.exit(1);
}

const endpoint = new URL(rawUrl);
endpoint.pathname = "/agent";
endpoint.searchParams.set("token", token);
if (endpoint.protocol === "https:") endpoint.protocol = "wss:";
if (endpoint.protocol === "http:") endpoint.protocol = "ws:";

function log(message: string): void {
  const stamp = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[${stamp}] ${message}\n`);
}

/** Collapse an SSE body into its last JSON-RPC payload, if it is complete. */
function fromSse(body: string): string | null {
  const frames = body.split(/\r?\n\r?\n+/);
  for (let i = frames.length - 1; i >= 0; i--) {
    const data = frames[i]
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    if (!data) continue;
    try {
      const parsed = JSON.parse(data) as { jsonrpc?: string; result?: unknown; error?: unknown };
      if (parsed.jsonrpc || parsed.result !== undefined || parsed.error !== undefined) return data;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

let socket: WebSocket | null = null;
let attempt = 0;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let shuttingDown = false;

function send(payload: unknown): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

async function forward(request: RelayRequest): Promise<void> {
  const started = Date.now();
  // The MCP transport requires both types to be acceptable; --json-response
  // decides which one is actually used. We request both and then verify.
  const headers: Record<string, string> = {
    ...request.headers,
    accept: "application/json, text/event-stream",
  };
  delete headers["content-length"];
  delete headers["accept-encoding"];

  try {
    const response = await fetch(local + request.path, {
      method: request.method,
      headers,
      body: request.body ?? undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(110_000),
    });

    const body = await response.text();
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(key)) {
        responseHeaders[key] = value;
      }
    });

    const contentType = response.headers.get("content-type") ?? "";
    let payload = body;

    if (contentType.includes("text/event-stream")) {
      // Tolerate an SSE answer by collapsing it to the final JSON-RPC frame.
      const extracted = fromSse(body);
      if (extracted === null) {
        send({
          type: "response",
          id: request.id,
          status: 502,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Local server streamed SSE without a complete response. Restart it with --json-response.",
            },
            id: null,
          }),
        });
        return;
      }
      payload = extracted;
      responseHeaders["content-type"] = "application/json";
    }

    if (verbose) {
      log(`${request.method} ${request.path} → ${response.status} (${Date.now() - started}ms, ${payload.length}b)`);
    }

    send({
      type: "response",
      id: request.id,
      status: response.status,
      headers: responseHeaders,
      body: payload,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`forward failed: ${message}`);
    send({
      type: "response",
      id: request.id,
      status: 502,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message }, id: null }),
    });
  }
}

function scheduleReconnect(): void {
  if (shuttingDown) return;
  attempt++;
  const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
  log(`reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${attempt})`);
  setTimeout(connect, delay);
}

function connect(): void {
  if (shuttingDown) return;
  log(`connecting to ${endpoint.origin}/agent`);

  const ws = new WebSocket(endpoint);
  socket = ws;

  ws.addEventListener("open", () => {
    attempt = 0;
    log(`connected — forwarding ${local} → ${endpoint.origin}/mcp`);
    clearInterval(heartbeat);
    heartbeat = setInterval(() => send({ type: "ping" }), 25_000);
  });

  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let message: Omit<Partial<RelayRequest>, "type"> & {
      type?: string;
      version?: string;
      server?: string;
    };
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === "hello") {
      log(`worker says hello (${message.version ?? "unknown"}, server ${message.server ?? "?"})`);
      send({ type: "hello", version: "0.1.0" });
      return;
    }
    if (message.type === "request") {
      void forward(message as RelayRequest);
    }
  });

  ws.addEventListener("close", (event) => {
    clearInterval(heartbeat);
    socket = null;
    log(`disconnected (${event.code}${event.reason ? ` ${event.reason}` : ""})`);
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    // The close handler drives reconnection.
    log("socket error");
  });
}

process.on("SIGINT", () => {
  shuttingDown = true;
  clearInterval(heartbeat);
  log("shutting down");
  try {
    socket?.close(1000, "agent shutdown");
  } catch {
    /* ignore */
  }
  process.exit(0);
});

log(`terminal-mcp relay agent → ${local}`);
connect();
