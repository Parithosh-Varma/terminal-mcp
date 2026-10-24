#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import http from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { config, ensureDirs, parseArgs } from "./config.js";
import { osSandboxStatus } from "./lib/osSandbox.js";
import { initSandbox, sandboxRoot } from "./lib/sandbox.js";
import { createServer, SERVER_NAME, SERVER_VERSION, toolCount } from "./server.js";

const HELP = `${SERVER_NAME} v${SERVER_VERSION} — sandboxed terminal MCP server

Usage:
  terminal-mcp [--stdio]                 speak MCP over stdin/stdout (Claude Desktop, Claude Code, Cursor)
  terminal-mcp --http [options]          serve MCP over streamable HTTP at /mcp

Core options:
  --root <dir>          workspace the agent is confined to (default ./workspace)
  --sandbox <mode>      strict | workspace | off   (default strict)
  --no-network          deny network access to sandboxed commands
  --timeout <ms>        default command timeout

HTTP options:
  --host <addr>         bind address (default 127.0.0.1)
  --port <port>         port (default 8787)
  --token <secret>      require Bearer auth (or TERMINAL_MCP_TOKEN)
  --stateless           no session tracking (simplest for hosted connectors)
  --json-response       answer with application/json instead of SSE (required behind the CF relay)

Examples:
  terminal-mcp --root ~/code/sandbox
  terminal-mcp --http --port 8787 --token $(openssl rand -hex 24)
`;

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help || args.h) {
    process.stdout.write(HELP);
    return;
  }
  if (args.version || args.v) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  ensureDirs();
  initSandbox();

  if (config.transport === "http") {
    await startHttp();
  } else {
    await startStdio();
  }
}

async function startStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdout belongs to the protocol — diagnostics go to stderr only.
  const sandbox = osSandboxStatus();
  process.stderr.write(
    `[${SERVER_NAME}] ready · ${toolCount()} tools · stdio · root=${sandboxRoot()} · mode=${config.mode}` +
      (sandbox.available ? ` · ${sandbox.kind}` : ` · OS sandbox unavailable (${sandbox.detail})`) +
      `\n`,
  );

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function startHttp(): Promise<void> {
  const loopback = config.host === "127.0.0.1" || config.host === "localhost" || config.host === "::1";
  if (!loopback && !config.token && !process.env.TERMINAL_MCP_ALLOW_INSECURE) {
    process.stderr.write(
      `[${SERVER_NAME}] refusing to bind ${config.host} without a token.\n` +
        `Set --token <secret> or TERMINAL_MCP_TOKEN, or ALLOW it explicitly with TERMINAL_MCP_ALLOW_INSECURE=1.\n`,
    );
    process.exit(1);
  }

  const app = express();
  app.use(express.json({ limit: "8mb" }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  const authorized = (req: Request): boolean => {
    if (!config.token) return true;
    const header = req.header("authorization") ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
    const query = typeof req.query.token === "string" ? req.query.token : "";
    return bearer === config.token || query === config.token;
  };

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      server: SERVER_NAME,
      version: SERVER_VERSION,
      tools: toolCount(),
      root: sandboxRoot(),
      mode: config.mode,
      network: config.allowNetwork,
    });
  });

  interface Session {
    transport: StreamableHTTPServerTransport;
    server: ReturnType<typeof createServer>;
  }
  const sessions = new Map<string, Session>();

  const handler = async (req: Request, res: Response): Promise<void> => {
    if (!authorized(req)) {
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
      return;
    }

    const sessionId = req.header("mcp-session-id");
    const existing = sessionId ? sessions.get(sessionId) : undefined;

    if (existing) {
      await existing.transport.handleRequest(req, res, req.body);
      return;
    }
    if (sessionId) {
      res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
      return;
    }

    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: config.stateless ? undefined : () => randomUUID(),
      enableJsonResponse: config.jsonResponse,
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server });
      },
    });

    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) sessions.delete(id);
      void server.close();
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  app.post("/mcp", handler);
  app.get("/mcp", handler);
  app.delete("/mcp", handler);

  const httpServer = http.createServer(app);

  await new Promise<void>((resolve) => {
    httpServer.listen(config.port, config.host, () => resolve());
  });

  const sandbox = osSandboxStatus();
  process.stdout.write(
    `[${SERVER_NAME}] ready · ${toolCount()} tools · http://${config.host}:${config.port}/mcp\n` +
      `  root:    ${sandboxRoot()}\n` +
      `  mode:    ${config.mode}${sandbox.available ? ` (${sandbox.kind})` : ` (OS sandbox unavailable: ${sandbox.detail})`}\n` +
      `  network: ${config.allowNetwork ? "allowed" : "denied"}\n` +
      `  auth:    ${config.token ? "bearer token required" : "none (loopback only)"}\n` +
      `  format:  ${config.jsonResponse ? "json" : "sse"}\n`,
  );

  const shutdown = async () => {
    httpServer.close();
    for (const session of sessions.values()) {
      await session.server.close().catch(() => undefined);
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  process.stderr.write(`[${SERVER_NAME}] fatal: ${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});
