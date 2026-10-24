import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type SandboxMode = "strict" | "workspace" | "off";

function arg(name: string): string | undefined {
  const argv = process.argv;
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i !== -1) {
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) return next;
  }
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const root = path.resolve(
  arg("root") ?? process.env.TERMINAL_MCP_ROOT ?? path.join(os.homedir(), "mcp-workspace"),
);

const rawMode = (arg("sandbox") ?? process.env.TERMINAL_MCP_SANDBOX ?? "strict").toLowerCase();
const mode: SandboxMode = rawMode === "workspace" || rawMode === "off" ? rawMode : "strict";

export const config = {
  transport: (hasFlag("http") || arg("transport") === "http" ? "http" : "stdio") as "stdio" | "http",
  root,
  mode,
  allowNetwork: !(hasFlag("no-network") || process.env.TERMINAL_MCP_NETWORK === "0"),
  stateless: hasFlag("stateless"),
  jsonResponse: hasFlag("json-response") || process.env.TERMINAL_MCP_JSON_RESPONSE === "1",
  extraReadPaths: splitList(process.env.TERMINAL_MCP_READ_PATHS),
  extraWritePaths: splitList(process.env.TERMINAL_MCP_WRITE_PATHS),
  host: arg("host") ?? process.env.TERMINAL_MCP_HOST ?? "127.0.0.1",
  port: Number(arg("port") ?? process.env.TERMINAL_MCP_PORT ?? 8787),
  token: arg("token") ?? process.env.TERMINAL_MCP_TOKEN ?? "",
  defaultTimeoutMs: Number(process.env.TERMINAL_MCP_TIMEOUT_MS ?? 120_000),
  maxOutputChars: Number(process.env.TERMINAL_MCP_MAX_OUTPUT ?? 60_000),
  auditPath: path.join(os.homedir(), ".terminal-mcp", "audit.log"),
};

export function ensureDirs(): void {
  fs.mkdirSync(config.root, { recursive: true });
  fs.mkdirSync(path.dirname(config.auditPath), { recursive: true });
}

export function parseArgs(): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = process.argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}
