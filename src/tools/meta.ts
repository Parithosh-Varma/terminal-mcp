import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";
import { clearAudit, readAudit } from "../lib/audit.js";
import { runShell } from "../lib/exec.js";
import { guard, ok } from "../lib/format.js";
import { osSandboxStatus } from "../lib/osSandbox.js";
import { resolveInside, sandboxRoot, toRelative } from "../lib/sandbox.js";
import { which } from "../lib/which.js";

export function registerMetaTools(server: McpServer): void {
  server.registerTool(
    "sandbox_info",
    {
      title: "Sandbox info",
      description:
        "Report how this server is confined: workspace root, enforcement mode, OS sandbox backend, network policy and limits.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      guard(async () => {
        const status = osSandboxStatus();
        const toolCount = 0;
        void toolCount;
        return ok(
          [
            `workspace root:   ${sandboxRoot()}`,
            `enforcement:      ${config.mode}`,
            `os sandbox:       ${status.available ? `${status.kind} (${status.detail})` : `off — ${status.detail}`}`,
            `network:          ${config.allowNetwork ? "allowed" : "denied"}`,
            `command timeout:  ${Math.round(config.defaultTimeoutMs / 1000)}s (default)`,
            `output cap:       ${config.maxOutputChars.toLocaleString()} chars`,
            `audit log:        ${config.auditPath}`,
            `extra read:       ${config.extraReadPaths.join(", ") || "(none)"}`,
            `extra write:      ${config.extraWritePaths.join(", ") || "(none)"}`,
            ``,
            `modes:`,
            `  strict     — path jail + OS kernel sandbox (default)`,
            `  workspace  — path jail only, commands run as your user`,
            `  off        — no confinement (dangerous)`,
          ].join("\n"),
        );
      }),
  );

  server.registerTool(
    "sandbox_selftest",
    {
      title: "Verify sandbox enforcement",
      description:
        "Actively probe the confinement: check that paths outside the workspace are rejected, that writing outside is blocked, " +
        "and that system paths remain readable. Returns a pass/fail report.",
      inputSchema: {},
      annotations: { readOnlyHint: false },
    },
    async () =>
      guard(async () => {
        const checks: Array<[string, boolean, string]> = [];
        const root = sandboxRoot();

        // 1. Tool-level path jail: escaping via .. must throw
        let jailBlocked = false;
        try {
          resolveInside("../escape-attempt");
        } catch {
          jailBlocked = true;
        }
        checks.push(["path jail rejects '..' escapes", jailBlocked, "resolveInside('../...')"]);

        // 2. Absolute path outside the root must throw
        let absBlocked = false;
        try {
          resolveInside(path.join(os.homedir(), "definitely-outside"));
        } catch {
          absBlocked = true;
        }
        checks.push(["path jail rejects absolute paths outside root", absBlocked, "resolveInside(~/...)"]);

        // 3. Kernel sandbox: writing outside the workspace should fail in strict mode
        const probe = path.join(os.homedir(), `.terminal-mcp-probe-${Date.now()}`);
        const writeResult = await runShell(`echo probe > ${JSON.stringify(probe)} && rm -f ${JSON.stringify(probe)}`, {
          timeoutMs: 15_000,
        });
        const writeBlocked = writeResult.exitCode !== 0;
        if (!writeBlocked) {
          try {
            fs.unlinkSync(probe);
          } catch {
            /* ignore */
          }
        }
        checks.push([
          "shell cannot write outside the workspace",
          writeBlocked,
          config.mode === "strict" ? "kernel sandbox" : "expected to fail only in strict mode",
        ]);

        // 4. Writing inside the workspace must succeed
        const inside = path.join(root, ".terminal-mcp-probe");
        const insideResult = await runShell(`echo probe > ${JSON.stringify(inside)} && rm -f ${JSON.stringify(inside)}`, {
          timeoutMs: 15_000,
        });
        checks.push(["shell can write inside the workspace", insideResult.exitCode === 0, "control test"]);

        // 5. System binaries must remain usable
        const readResult = await runShell("cat /etc/hosts > /dev/null 2>&1 || echo fail", { timeoutMs: 15_000 });
        checks.push(["system files remain readable", !readResult.stdout.includes("fail"), "/etc/hosts"]);

        const passed = checks.filter(([, okFlag]) => okFlag).length;
        const lines = checks.map(([name, okFlag, detail]) => `${okFlag ? "PASS" : "FAIL"}  ${name}  (${detail})`);

        return ok(
          `Sandbox self-test — ${passed}/${checks.length} passed\n` +
            `root: ${root}\nmode: ${config.mode}\n\n${lines.join("\n")}` +
            (config.mode !== "strict"
              ? "\n\nNote: the write-outside check is only enforced in strict mode."
              : ""),
        );
      }),
  );

  server.registerTool(
    "command_history",
    {
      title: "Command history",
      description: "Show recent commands and tool actions recorded by this server, newest last.",
      inputSchema: {
        limit: z.number().int().min(1).max(1000).optional().describe("Default 50."),
        tool: z.string().optional().describe('Filter by tool name, e.g. "run_command".'),
        only_failed: z.boolean().optional().describe("Only show non-zero exit codes."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        const entries = await readAudit(args.limit ?? 50, args.tool);
        const filtered = args.only_failed ? entries.filter((e) => e.exitCode !== undefined && e.exitCode !== 0) : entries;
        if (!filtered.length) return ok(`No matching audit entries in ${config.auditPath}.`);

        const lines = filtered.map((e) => {
          const status = e.exitCode === undefined ? "" : e.exitCode === 0 ? " ok" : ` exit=${e.exitCode}`;
          const duration = e.durationMs !== undefined ? ` ${e.durationMs}ms` : "";
          const detail = e.detail ? ` — ${e.detail}` : "";
          return `${e.ts.slice(0, 19).replace("T", " ")}  ${e.tool.padEnd(18)}${status}${duration}  ${e.command ?? detail}`;
        });

        return ok(`${filtered.length} entries (${config.auditPath})\n\n${lines.join("\n")}`);
      }),
  );

  server.registerTool(
    "clear_history",
    {
      title: "Clear command history",
      description: "Delete the audit log contents. The log lives outside the workspace so tools cannot tamper with it.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async () =>
      guard(async () => {
        await clearAudit();
        return ok("Audit log cleared.");
      }),
  );

  server.registerTool(
    "list_capabilities",
    {
      title: "List capabilities",
      description:
        "Report which optional host tools are installed (git, ripgrep, python, docker, ffmpeg, etc.) so you know what you can call.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      guard(async () => {
        const candidates = [
          "git",
          "gh",
          "node",
          "npm",
          "pnpm",
          "yarn",
          "bun",
          "python3",
          "pip3",
          "uv",
          "go",
          "cargo",
          "rustc",
          "java",
          "ruby",
          "php",
          "rg",
          "fd",
          "jq",
          "curl",
          "wget",
          "docker",
          "kubectl",
          "ffmpeg",
          "imagemagick",
          "convert",
          "sqlite3",
          "psql",
          "redis-cli",
          "make",
          "cmake",
          "gcc",
          "clang",
          "zip",
          "unzip",
          "tar",
          "pandoc",
          "aws",
          "terraform",
        ];

        const found: string[] = [];
        const missing: string[] = [];
        for (const bin of candidates) {
          (which(bin) ? found : missing).push(bin);
        }

        return ok(
          `available (${found.length}):\n${found.join(", ") || "(none)"}\n\n` +
            `not installed (${missing.length}):\n${missing.join(", ")}\n\n` +
            `workspace: ${toRelative(sandboxRoot()) === "." ? sandboxRoot() : sandboxRoot()}`,
        );
      }),
  );
}

export const metaToolNames = [
  "sandbox_info",
  "sandbox_selftest",
  "command_history",
  "clear_history",
  "list_capabilities",
];
