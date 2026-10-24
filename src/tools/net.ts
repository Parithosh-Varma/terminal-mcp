import dns from "node:dns/promises";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";
import { logAudit } from "../lib/audit.js";
import { runCommand } from "../lib/exec.js";
import { fail, guard, ok, humanBytes } from "../lib/format.js";
import { resolveInside, toRelative } from "../lib/sandbox.js";

const BODY_CAP = 200_000;

function networkBlocked(): boolean {
  return !config.allowNetwork;
}

async function fetchWithTimeout(url: string, init: RequestInit & { timeoutMs?: number }): Promise<Response> {
  const { timeoutMs = 30_000, ...rest } = init;
  return await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs), redirect: rest.redirect ?? "follow" });
}

export function registerNetTools(server: McpServer): void {
  server.registerTool(
    "http_request",
    {
      title: "HTTP request",
      description:
        "Perform an HTTP/HTTPS request and return status, headers and body. Useful for APIs, health checks and webhooks. " +
        "Large or binary bodies are summarised.",
      inputSchema: {
        url: z.string().url().describe("Absolute http(s) URL."),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).optional().describe("Default GET."),
        headers: z.record(z.string()).optional().describe("Request headers."),
        body: z.string().optional().describe("Request body (string). JSON is not encoded automatically."),
        json: z.any().optional().describe("JSON body; sets Content-Type automatically."),
        timeout_ms: z.number().int().min(1000).max(300_000).optional().describe("Default 30000."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        if (networkBlocked()) return fail("Network access is disabled for this server (started with --no-network).");

        const headers = new Headers(args.headers ?? {});
        let body: RequestInit["body"] | undefined = args.body;
        if (args.json !== undefined) {
          body = JSON.stringify(args.json);
          if (!headers.has("content-type")) headers.set("content-type", "application/json");
        }

        const started = Date.now();
        const response = await fetchWithTimeout(args.url, {
          method: args.method ?? (body ? "POST" : "GET"),
          headers,
          body: body as RequestInit["body"] | undefined,
          timeoutMs: args.timeout_ms,
        });

        const contentType = response.headers.get("content-type") ?? "";
        const buffer = Buffer.from(await response.arrayBuffer());
        const duration = Date.now() - started;

        let payload: string;
        const textual =
          contentType.includes("json") ||
          contentType.includes("text") ||
          contentType.includes("xml") ||
          contentType.includes("javascript") ||
          contentType.includes("html") ||
          contentType === "";

        if (!textual) {
          payload = `(binary body, ${humanBytes(buffer.length)}) base64:\n${buffer.subarray(0, 20_000).toString("base64")}`;
        } else {
          const text = buffer.toString("utf8");
          payload = text.length > BODY_CAP ? text.slice(0, BODY_CAP) + `\n… [${text.length - BODY_CAP} chars cut]` : text;
        }

        const headerLines = [...response.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
        await logAudit({ ts: new Date().toISOString(), tool: "http_request", command: `${args.method ?? "GET"} ${args.url}`, durationMs: duration });

        return ok(
          `HTTP ${response.status} ${response.statusText} — ${duration}ms\n` +
            `${args.url}\n--- headers ---\n${headerLines}\n\n--- body ---\n${payload}`,
        );
      }),
  );

  server.registerTool(
    "download_file",
    {
      title: "Download file",
      description: "Download a URL to a file inside the sandbox. Refuses to overwrite unless overwrite=true.",
      inputSchema: {
        url: z.string().url(),
        path: z.string().describe("Destination path relative to the sandbox root."),
        overwrite: z.boolean().optional(),
        max_mb: z.number().min(0.1).max(2048).optional().describe("Abort if larger than this. Default 200."),
        headers: z.record(z.string()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        if (networkBlocked()) return fail("Network access is disabled (--no-network).");
        const target = resolveInside(args.path);
        if (fs.existsSync(target) && !args.overwrite) return fail(`Destination exists: ${toRelative(target)}`);

        const response = await fetchWithTimeout(args.url, { headers: args.headers, timeoutMs: 300_000 });
        if (!response.ok) return fail(`Download failed: HTTP ${response.status} ${response.statusText}`);
        if (!response.body) return fail("Download failed: empty response body.");

        const limit = (args.max_mb ?? 200) * 1024 * 1024;
        const announced = Number(response.headers.get("content-length") ?? 0);
        if (announced && announced > limit) return fail(`File is ${humanBytes(announced)}, above the ${args.max_mb ?? 200}MB limit.`);

        await fsp.mkdir(path.dirname(target), { recursive: true });
        let written = 0;
        const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
        const dest = fs.createWriteStream(target);

        await pipeline(
          source,
          async function* (stream) {
            for await (const chunk of stream) {
              written += (chunk as Buffer).length;
              if (written > limit) throw new Error(`Download exceeded ${args.max_mb ?? 200}MB limit.`);
              yield chunk;
            }
          },
          dest,
        );

        await logAudit({ ts: new Date().toISOString(), tool: "download_file", command: args.url, detail: toRelative(target) });
        return ok(`Downloaded ${humanBytes(written)} → ${toRelative(target)}`);
      }),
  );

  server.registerTool(
    "check_port",
    {
      title: "Check TCP port",
      description: "Test whether a TCP port is open on a host (default localhost).",
      inputSchema: {
        port: z.number().int().min(1).max(65535),
        host: z.string().optional().describe("Default 127.0.0.1."),
        timeout_ms: z.number().int().min(100).max(30_000).optional().describe("Default 3000."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () =>
        await new Promise<ReturnType<typeof ok>>((resolve) => {
          const socket = new net.Socket();
          const done = (message: string, open: boolean) => {
            socket.destroy();
            resolve(open ? ok(message) : fail(message));
          };
          socket.setTimeout(args.timeout_ms ?? 3000);
          socket.once("connect", () => done(`${args.host ?? "127.0.0.1"}:${args.port} is OPEN`, true));
          socket.once("timeout", () => done(`${args.host ?? "127.0.0.1"}:${args.port} timed out`, false));
          socket.once("error", (error) => done(`${args.host ?? "127.0.0.1"}:${args.port} is CLOSED (${error.message})`, false));
          socket.connect(args.port, args.host ?? "127.0.0.1");
        }),
      ),
  );

  server.registerTool(
    "dns_lookup",
    {
      title: "DNS lookup",
      description: "Resolve a hostname (A/AAAA/MX/TXT/CNAME/NS) or reverse-resolve an IP.",
      inputSchema: {
        host: z.string().describe("Hostname or IP address."),
        type: z.enum(["A", "AAAA", "MX", "TXT", "CNAME", "NS", "PTR"]).optional().describe("Default A."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        if (networkBlocked()) return fail("Network access is disabled (--no-network).");
        const type = args.type ?? "A";
        try {
          let records: unknown;
          if (type === "A") records = await dns.resolve4(args.host);
          else if (type === "AAAA") records = await dns.resolve6(args.host);
          else if (type === "MX") records = await dns.resolveMx(args.host);
          else if (type === "TXT") records = await dns.resolveTxt(args.host);
          else if (type === "CNAME") records = await dns.resolveCname(args.host);
          else if (type === "NS") records = await dns.resolveNs(args.host);
          else records = await dns.reverse(args.host);

          return ok(`${type} records for ${args.host}:\n${JSON.stringify(records, null, 2)}`);
        } catch (error) {
          return fail(`DNS lookup failed: ${(error as Error).message}`);
        }
      }),
  );

  server.registerTool(
    "ping",
    {
      title: "Ping host",
      description: "Send ICMP echo requests to check reachability and latency.",
      inputSchema: {
        host: z.string(),
        count: z.number().int().min(1).max(20).optional().describe("Default 4."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        if (networkBlocked()) return fail("Network access is disabled (--no-network).");
        const result = await runCommand("ping", ["-c", String(args.count ?? 4), args.host], { timeoutMs: 30_000 });
        return ok([result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n") || "(no output)");
      }),
  );

  server.registerTool(
    "public_ip",
    {
      title: "Public IP",
      description: "Look up the machine's public IP address and approximate location.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      guard(async () => {
        if (networkBlocked()) return fail("Network access is disabled (--no-network).");
        const response = await fetchWithTimeout("https://ipinfo.io/json", { timeoutMs: 10_000 });
        if (!response.ok) return fail(`Lookup failed: HTTP ${response.status}`);
        return ok(await response.text());
      }),
  );
}

export const netToolNames = ["http_request", "download_file", "check_port", "dns_lookup", "ping", "public_ip"];
