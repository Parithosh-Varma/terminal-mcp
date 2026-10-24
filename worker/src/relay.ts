import type { Env } from "./index.js";
import {
  type RelayResponse,
  type WorkerMessage,
  jsonRpcError,
  sanitizeHeaders,
} from "./protocol.js";

interface Pending {
  resolve: (response: RelayResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 120_000;
const AGENT_TAG = "agent";

/**
 * Single Durable Object instance that owns the outbound WebSocket to the Mac.
 * HTTP requests from ChatGPT are serialised onto that socket and the agent's
 * reply is returned verbatim.
 */
export class Relay implements DurableObject {
  private pending = new Map<string, Pending>();
  private connectedAt = 0;
  private agentVersion = "";

  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/agent") return this.handleAgent(request);
    if (url.pathname === "/health") return this.handleHealth();
    if (url.pathname === "/mcp") return this.handleMcp(request);

    return new Response("not found", { status: 404 });
  }

  // ---------------------------------------------------------------- agent

  private handleAgent(request: Request): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    // One agent at a time: a reconnect supersedes a stale socket.
    for (const old of this.ctx.getWebSockets(AGENT_TAG)) {
      try {
        old.close(1012, "replaced by a newer connection");
      } catch {
        /* already gone */
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernation-aware accept: the socket survives DO eviction.
    this.ctx.acceptWebSocket(server, [AGENT_TAG]);
    this.connectedAt = Date.now();

    const hello: WorkerMessage = {
      type: "hello",
      server: this.env.RELAY_NAME ?? "terminal-mcp",
      time: new Date().toISOString(),
    };
    server.send(JSON.stringify(hello));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;

    let message: { type?: string; id?: string; version?: string };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message.type === "hello") {
      this.agentVersion = message.version ?? "unknown";
      return;
    }

    if (message.type === "pong") return;

    if (message.type === "response" && message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      pending.resolve(message as unknown as RelayResponse);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.failAll(`agent disconnected (${code} ${reason})`.trim());
    try {
      ws.close(code, reason);
    } catch {
      /* ignore */
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.failAll("agent socket error");
  }

  private failAll(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({
        type: "response",
        id,
        status: 502,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: reason },
          id: null,
        }),
      });
    }
    this.pending.clear();
    this.connectedAt = 0;
    this.agentVersion = "";
  }

  // ------------------------------------------------------------------ mcp

  private async handleMcp(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
          "access-control-allow-headers":
            "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
          "access-control-expose-headers": "Mcp-Session-Id",
          "access-control-max-age": "86400",
        },
      });
    }

    // Server-initiated SSE is not relayed; the spec allows 405 here.
    if (request.method === "GET") {
      return new Response("SSE stream not supported by this relay", {
        status: 405,
        headers: { allow: "POST, DELETE, OPTIONS", "cache-control": "no-store" },
      });
    }

    if (request.method !== "POST" && request.method !== "DELETE") {
      return new Response("method not allowed", { status: 405, headers: { allow: "POST, DELETE, OPTIONS" } });
    }

    const sockets = this.ctx.getWebSockets(AGENT_TAG);
    const ws = sockets[0];
    if (!ws) {
      return jsonRpcError(503, -32000, "Local agent is not connected. Start it with: npm run relay");
    }

    const body = await request.text();
    const id = crypto.randomUUID();

    const reply = new Promise<RelayResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          type: "response",
          id,
          status: 504,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Local agent timed out after 120s" },
            id: null,
          }),
        });
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, timer });
    });

    ws.send(
      JSON.stringify({
        type: "request",
        id,
        method: request.method,
        path: "/mcp",
        headers: sanitizeHeaders(request.headers),
        body,
      }),
    );

    const response = await reply;
    const headers = new Headers(response.headers);
    headers.set("access-control-allow-origin", "*");
    headers.set("access-control-expose-headers", "Mcp-Session-Id");
    headers.delete("content-length");

    return new Response(response.body, { status: response.status, headers });
  }

  private handleHealth(): Response {
    const sockets = this.ctx.getWebSockets(AGENT_TAG);
    return new Response(
      JSON.stringify({
        online: sockets.length > 0,
        agents: sockets.length,
        connectedSince: this.connectedAt ? new Date(this.connectedAt).toISOString() : null,
        agentVersion: this.agentVersion || null,
        pending: this.pending.size,
        server: this.env.RELAY_NAME ?? "terminal-mcp",
      }),
      {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        },
      },
    );
  }
}
