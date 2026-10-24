import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";
import { logAudit } from "../lib/audit.js";
import { runCommand, runShell, renderExecResult } from "../lib/exec.js";
import { fail, guard, ok } from "../lib/format.js";
import {
  getManaged,
  isRunning,
  killManaged,
  listManaged,
  readManaged,
  startManaged,
  waitManaged,
  writeManaged,
} from "../lib/processes.js";
import { resolveInside, sandboxRoot, toRelative } from "../lib/sandbox.js";
import { which } from "../lib/which.js";

const cwdArg = z
  .string()
  .optional()
  .describe("Working directory, relative to the sandbox root. Defaults to the root itself.");

export function registerShellTools(server: McpServer): void {
  server.registerTool(
    "run_command",
    {
      title: "Run shell command",
      description:
        "Execute a shell command inside the sandboxed workspace and return its stdout, stderr, exit code and duration. " +
        "Use this for builds, tests, package managers, CLI tools, scripts and anything else that runs on the machine. " +
        "Commands are confined to the sandbox root (default ./workspace). Long outputs are truncated in the middle.",
      inputSchema: {
        command: z.string().min(1).describe("Shell command line to execute, e.g. `npm test` or `git status`."),
        cwd: cwdArg,
        timeout_ms: z
          .number()
          .int()
          .min(1000)
          .max(3_600_000)
          .optional()
          .describe("Kill the process after this many milliseconds. Default 120000, max 1 hour."),
        env: z.record(z.string()).optional().describe("Extra environment variables for this command only."),
        stdin: z.string().optional().describe("Text to pipe into the command's stdin."),
        background: z
          .boolean()
          .optional()
          .describe("Start as a background process instead of waiting. Returns a process id for read_process."),
        max_output_chars: z.number().int().min(500).max(500_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        if (args.background) {
          const proc = startManaged(args.command, { cwd: args.cwd });
          await logAudit({
            ts: new Date().toISOString(),
            tool: "run_command(background)",
            command: args.command,
            cwd: proc.cwd,
          });
          return ok(
            `Started background process \`${proc.id}\`\n` +
              `command: ${args.command}\n` +
              `cwd: ${proc.cwd}\n` +
              `Read it with read_process id="${proc.id}".`,
          );
        }

        const result = await runShell(args.command, {
          cwd: args.cwd,
          timeoutMs: args.timeout_ms,
          env: args.env,
          stdin: args.stdin,
          maxChars: args.max_output_chars,
        });

        await logAudit({
          ts: new Date().toISOString(),
          tool: "run_command",
          command: args.command,
          cwd: toRelative(resolveInside(args.cwd ?? ".")),
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        });

        return ok(renderExecResult(result));
      }),
  );

  server.registerTool(
    "run_script",
    {
      title: "Run inline script",
      description:
        "Write a short script to the sandbox temp folder and execute it with bash, python3 or node. " +
        "Convenient for multi-line logic without shell-quoting pain.",
      inputSchema: {
        language: z.enum(["bash", "python", "node"]).describe("Interpreter to use."),
        code: z.string().min(1).describe("Script source code."),
        cwd: cwdArg,
        timeout_ms: z.number().int().min(1000).max(3_600_000).optional(),
        args: z.array(z.string()).optional().describe("Extra argv passed to the script."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const ext = args.language === "python" ? "py" : args.language === "node" ? "mjs" : "sh";
        const dir = path.join(sandboxRoot(), ".tmp", "scripts");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `script-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`);
        fs.writeFileSync(file, args.code, "utf8");

        const interpreter =
          args.language === "node" ? process.execPath : args.language === "python" ? which("python3") : "/bin/bash";
        if (!interpreter) return fail("python3 was not found on PATH.");

        const result = await runCommand(interpreter, [file, ...(args.args ?? [])], {
          cwd: args.cwd,
          timeoutMs: args.timeout_ms,
        });

        await logAudit({
          ts: new Date().toISOString(),
          tool: "run_script",
          command: `${args.language}:${toRelative(file)}`,
          cwd: toRelative(resolveInside(args.cwd ?? ".")),
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        });

        return ok(renderExecResult(result));
      }),
  );

  server.registerTool(
    "start_process",
    {
      title: "Start background process",
      description:
        "Start a long-running command (dev server, watcher, tunnel) in the background. Returns a process id. " +
        "Its stdin stays open so write_process can interact with it.",
      inputSchema: {
        command: z.string().min(1).describe("Command line to run in the background."),
        cwd: cwdArg,
        name: z.string().max(40).optional().describe("Optional stable id, e.g. `devserver`."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const proc = startManaged(args.command, { cwd: args.cwd, name: args.name });
        await logAudit({
          ts: new Date().toISOString(),
          tool: "start_process",
          command: args.command,
          cwd: proc.cwd,
        });
        return ok(
          `Started \`${proc.id}\` (pid ${proc.child.pid ?? "?"})\n` +
            `command: ${proc.command}\ncwd: ${proc.cwd}\n` +
            `Use read_process id="${proc.id}" to fetch output.`,
        );
      }),
  );

  server.registerTool(
    "read_process",
    {
      title: "Read background process output",
      description:
        "Read buffered stdout/stderr from a process started with start_process. Pass the previous offset to get only new output.",
      inputSchema: {
        id: z.string().describe("Process id returned by start_process."),
        offset: z.number().int().min(0).optional().describe("Character offset from a previous read; returns only newer output."),
        stream: z.enum(["both", "stdout", "stderr"]).optional().describe("Which stream to read. Default both."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        const result = readManaged(args.id, { offset: args.offset, stream: args.stream });
        if (!result) return fail(`No managed process with id "${args.id}". Try list_processes.`);
        const status = result.running ? "running" : `exited (${result.exitCode ?? "?"})`;
        return ok(`[${status}] offset=${result.offset}\n${result.output || "(no new output)"}`);
      }),
  );

  server.registerTool(
    "write_process",
    {
      title: "Write to process stdin",
      description: "Send text to the stdin of a background process. Add \\n explicitly if the program waits for a line.",
      inputSchema: {
        id: z.string(),
        input: z.string().describe("Text to write, e.g. `y\\n`."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) =>
      guard(async () => {
        const written = writeManaged(args.id, args.input);
        return written ? ok(`Wrote ${args.input.length} chars to ${args.id}.`) : fail(`Cannot write to "${args.id}" (missing or stdin closed).`);
      }),
  );

  server.registerTool(
    "kill_process",
    {
      title: "Stop background process",
      description: "Terminate a managed background process (or any pid) with a signal.",
      inputSchema: {
        id: z.string().optional().describe("Managed process id."),
        pid: z.number().int().positive().optional().describe("Raw OS pid, if you know it."),
        signal: z.enum(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"]).optional().describe("Default SIGTERM."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) =>
      guard(async () => {
        const signal = args.signal ?? "SIGTERM";
        if (args.id) {
          const proc = getManaged(args.id);
          if (!proc) return fail(`No managed process "${args.id}".`);
          const done = killManaged(args.id, signal);
          await logAudit({ ts: new Date().toISOString(), tool: "kill_process", command: proc.command, detail: signal });
          return done ? ok(`Sent ${signal} to ${args.id}.`) : fail(`Could not signal ${args.id} (already exited?).`);
        }
        if (args.pid) {
          try {
            process.kill(args.pid, signal);
            await logAudit({ ts: new Date().toISOString(), tool: "kill_process", detail: `pid ${args.pid} ${signal}` });
            return ok(`Sent ${signal} to pid ${args.pid}.`);
          } catch (error) {
            return fail(`Could not signal pid ${args.pid}: ${(error as Error).message}`);
          }
        }
        return fail("Provide either id or pid.");
      }),
  );

  server.registerTool(
    "wait_process",
    {
      title: "Wait for process exit",
      description: "Block until a managed process exits or the timeout elapses, then report its status.",
      inputSchema: {
        id: z.string(),
        timeout_ms: z.number().int().min(1000).max(600_000).optional().describe("Default 30000."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        const finished = await waitManaged(args.id, args.timeout_ms ?? 30_000);
        const proc = getManaged(args.id);
        if (!proc) return fail(`No managed process "${args.id}".`);
        const tail = readManaged(args.id, { offset: Math.max(0, (proc.stdout + proc.stderr).length - 4000) });
        return ok(
          (finished ? `Exited with code ${proc.exitCode ?? "?"}.` : "Still running after timeout.") +
            `\n\nRecent output:\n${tail?.output || "(none)"}`,
        );
      }),
  );

  server.registerTool(
    "list_processes",
    {
      title: "List processes",
      description:
        "List processes managed by this server (ids, commands, status). Set include_system to also snapshot `ps` output.",
      inputSchema: {
        include_system: z.boolean().optional().describe("Also include a ps snapshot of the whole machine."),
        filter: z.string().optional().describe("Only show processes whose command matches this regex or substring."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        const managed = listManaged();
        const matcher = args.filter ? new RegExp(args.filter, "i") : undefined;
        const rows = managed
          .filter((p) => !matcher || matcher.test(p.command))
          .map(
            (p) =>
              `${p.id.padEnd(14)} ${isRunning(p) ? "running" : `exit ${p.exitCode ?? "?"}`}  ` +
              `${Math.round((Date.now() - p.startedAt) / 1000)}s  ${p.command}`,
          );

        let output = rows.length ? rows.join("\n") : "(no managed processes)";

        if (args.include_system) {
          const ps = await runCommand("ps", ["-Ao", "pid,ppid,stat,etime,command"], { maxChars: 20_000 });
          const lines = ps.stdout
            .split("\n")
            .filter((line) => !matcher || matcher.test(line))
            .slice(0, 120);
          output += `\n\n--- system processes ---\n${lines.join("\n")}`;
        }

        return ok(output);
      }),
  );

  server.registerTool(
    "kill_all_processes",
    {
      title: "Stop all managed processes",
      description: "Terminate every background process this server started. Useful before finishing a session.",
      inputSchema: {
        signal: z.enum(["SIGTERM", "SIGKILL"]).optional().describe("Default SIGTERM."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) =>
      guard(async () => {
        const running = listManaged().filter((p) => isRunning(p));
        for (const proc of running) killManaged(proc.id, args.signal ?? "SIGTERM");
        await logAudit({ ts: new Date().toISOString(), tool: "kill_all_processes", detail: `${running.length} stopped` });
        return ok(running.length ? `Stopped ${running.length}: ${running.map((p) => p.id).join(", ")}` : "Nothing was running.");
      }),
  );

  // Expose the sandbox root in tool descriptions users see.
  void config;
}

export const shellToolNames = [
  "run_command",
  "run_script",
  "start_process",
  "read_process",
  "write_process",
  "kill_process",
  "wait_process",
  "list_processes",
  "kill_all_processes",
];
