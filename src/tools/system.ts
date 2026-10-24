import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";
import { runCommand } from "../lib/exec.js";
import { fail, guard, humanBytes, ok } from "../lib/format.js";
import { osSandboxStatus } from "../lib/osSandbox.js";
import { resolveInside, sandboxRoot, toRelative } from "../lib/sandbox.js";
import { which } from "../lib/which.js";

/** AppleScript string literal: double quotes, escaped backslashes and quotes. */
function appleScriptQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function clipboardCommand(read: boolean): { bin: string; args: string[] } {
  if (process.platform === "darwin") return { bin: read ? "pbpaste" : "pbcopy", args: [] };
  if (which("wl-paste") && read) return { bin: "wl-paste", args: [] };
  if (which("wl-copy") && !read) return { bin: "wl-copy", args: [] };
  return { bin: read ? "xclip" : "xclip", args: read ? ["-selection", "clipboard", "-o"] : ["-selection", "clipboard"] };
}

const SECRET_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE)/i;

export function registerSystemTools(server: McpServer): void {
  server.registerTool(
    "system_info",
    {
      title: "System information",
      description: "OS, CPU, memory, uptime, user, shell, runtime versions and the sandbox configuration.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      guard(async () => {
        const cpus = os.cpus();
        const sandbox = osSandboxStatus();
        const lines = [
          `hostname:   ${os.hostname()}`,
          `platform:   ${os.platform()} ${os.release()} (${os.arch()})`,
          `user:       ${os.userInfo().username} (${os.userInfo().shell ?? "?"})`,
          `cpu:        ${cpus[0]?.model ?? "unknown"} — ${cpus.length} cores`,
          `memory:     ${humanBytes(os.freemem())} free of ${humanBytes(os.totalmem())}`,
          `load avg:   ${os.loadavg().map((n) => n.toFixed(2)).join(", ")}`,
          `uptime:     ${Math.floor(os.uptime() / 3600)}h ${Math.floor((os.uptime() % 3600) / 60)}m`,
          `node:       ${process.version}`,
          `server pid: ${process.pid}`,
          ``,
          `sandbox root:     ${sandboxRoot()}`,
          `sandbox mode:     ${config.mode}`,
          `os sandbox:       ${sandbox.available ? sandbox.kind : `unavailable (${sandbox.detail})`}`,
          `network:          ${config.allowNetwork ? "allowed" : "denied"}`,
        ];
        return ok(lines.join("\n"));
      }),
  );

  server.registerTool(
    "disk_usage",
    {
      title: "Disk usage",
      description: "Show free/used space for mounted volumes, or the size of a folder inside the sandbox.",
      inputSchema: {
        path: z.string().optional().describe("Folder inside the sandbox to measure with du. Omit for volume overview."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        if (args.path) {
          const dir = resolveInside(args.path);
          const result = await runCommand("du", ["-sh", dir], { host: true, timeoutMs: 60_000 });
          return ok(result.stdout.trim() || result.stderr.trim() || "(no output)");
        }
        const result = await runCommand("df", ["-h"], { host: true });
        return ok(result.stdout.trim() || result.stderr.trim());
      }),
  );

  server.registerTool(
    "env_vars",
    {
      title: "Environment variables",
      description:
        "List the environment the server and its commands inherit. Sensitive-looking values are masked unless reveal=true.",
      inputSchema: {
        filter: z.string().optional().describe("Only keys matching this substring/regex."),
        reveal: z.boolean().optional().describe("Show full values instead of masking secrets."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        const matcher = args.filter ? new RegExp(args.filter, "i") : undefined;
        const rows = Object.entries(process.env)
          .filter(([key]) => !matcher || matcher.test(key))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => {
            const masked = !args.reveal && SECRET_PATTERN.test(key);
            const shown = masked ? `${(value ?? "").slice(0, 4)}… (${(value ?? "").length} chars)` : (value ?? "");
            return `${key}=${shown}`;
          });
        return ok(rows.join("\n") || "(no matching variables)");
      }),
  );

  server.registerTool(
    "clipboard_read",
    {
      title: "Read clipboard",
      description: "Return the current text contents of the system clipboard.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      guard(async () => {
        const { bin, args } = clipboardCommand(true);
        if (!which(bin)) return fail(`Clipboard tool "${bin}" is not installed.`);
        const result = await runCommand(bin, args, { host: true, timeoutMs: 10_000 });
        return ok(result.exitCode === 0 ? result.stdout || "(clipboard is empty)" : result.stderr);
      }),
  );

  server.registerTool(
    "clipboard_write",
    {
      title: "Write clipboard",
      description: "Copy text to the system clipboard.",
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: false },
    },
    async (args) =>
      guard(async () => {
        const { bin, args: cmdArgs } = clipboardCommand(false);
        if (!which(bin)) return fail(`Clipboard tool "${bin}" is not installed.`);
        const result = await runCommand(bin, cmdArgs, { host: true, stdin: args.text, timeoutMs: 10_000 });
        return result.exitCode === 0 ? ok(`Copied ${args.text.length} characters.`) : fail(result.stderr || "Clipboard write failed.");
      }),
  );

  server.registerTool(
    "screenshot",
    {
      title: "Take screenshot",
      description:
        "Capture the screen (or a single window) to a PNG inside the sandbox. Returns the file path so it can be read or served. " +
        "Requires screen-recording permission on macOS.",
      inputSchema: {
        path: z.string().optional().describe('Destination PNG. Default "screenshots/shot-<timestamp>.png".'),
        window: z.boolean().optional().describe("Capture only the frontmost window."),
        display: z.number().int().min(0).optional().describe("Display index to capture."),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) =>
      guard(async () => {
        const target = resolveInside(
          args.path ?? path.join("screenshots", `shot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`),
        );

        if (process.platform === "darwin") {
          const argv = ["-x"];
          if (args.window) argv.push("-o", "-w");
          if (args.display !== undefined) argv.push("-D", String(args.display + 1));
          argv.push(target);
          const result = await runCommand("/usr/sbin/screencapture", argv, { host: true, timeoutMs: 30_000 });
          if (result.exitCode !== 0) return fail(result.stderr || "screencapture failed.");
        } else if (which("gnome-screenshot")) {
          const result = await runCommand("gnome-screenshot", ["-f", target], { host: true, timeoutMs: 30_000 });
          if (result.exitCode !== 0) return fail(result.stderr || "gnome-screenshot failed.");
        } else if (which("scrot")) {
          const result = await runCommand("scrot", [target], { host: true, timeoutMs: 30_000 });
          if (result.exitCode !== 0) return fail(result.stderr || "scrot failed.");
        } else {
          return fail("No screenshot utility available on this platform.");
        }

        return ok(`Saved ${toRelative(target)}`);
      }),
  );

  server.registerTool(
    "notify",
    {
      title: "Desktop notification",
      description: "Show a native desktop notification. Useful to alert the user when a long task finishes.",
      inputSchema: {
        title: z.string().describe("Notification title."),
        message: z.string().optional().describe("Body text."),
        sound: z.boolean().optional().describe("Play the default alert sound (macOS)."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        if (process.platform === "darwin") {
          const sound = args.sound ? ' sound name "Glass"' : "";
          const script = `display notification ${appleScriptQuote(args.message ?? "")} with title ${appleScriptQuote(args.title)}${sound}`;
          const result = await runCommand("osascript", ["-e", script], { host: true, timeoutMs: 10_000 });
          return result.exitCode === 0 ? ok("Notification shown.") : fail(result.stderr);
        }
        if (which("notify-send")) {
          const result = await runCommand("notify-send", [args.title, args.message ?? ""], { host: true, timeoutMs: 10_000 });
          return result.exitCode === 0 ? ok("Notification shown.") : fail(result.stderr);
        }
        return fail("No notification utility available.");
      }),
  );

  server.registerTool(
    "open_url",
    {
      title: "Open URL in browser",
      description: "Open an http(s) URL in the user's default browser.",
      inputSchema: { url: z.string().url() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        if (!/^https?:\/\//i.test(args.url)) return fail("Only http(s) URLs can be opened.");
        const bin = process.platform === "darwin" ? "open" : which("xdg-open") ? "xdg-open" : undefined;
        if (!bin) return fail("No browser opener available.");
        const result = await runCommand(bin, [args.url], { host: true, timeoutMs: 10_000 });
        return result.exitCode === 0 ? ok(`Opened ${args.url}`) : fail(result.stderr);
      }),
  );

  server.registerTool(
    "listening_ports",
    {
      title: "Listening ports",
      description: "List TCP ports currently listening on this machine, with the owning process.",
      inputSchema: {
        filter: z.string().optional().describe("Only show lines matching this substring/regex."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        const result =
          process.platform === "darwin"
            ? await runCommand("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], { host: true, timeoutMs: 20_000 })
            : await runCommand("ss", ["-tlnp"], { host: true, timeoutMs: 20_000 });

        const lines = result.stdout
          .split("\n")
          .filter((line) => !args.filter || new RegExp(args.filter, "i").test(line));
        return ok(lines.join("\n") || "(nothing listening)");
      }),
  );

  server.registerTool(
    "which_command",
    {
      title: "Locate executable",
      description: "Resolve an executable name to its absolute path, and report its version if it supports --version.",
      inputSchema: {
        name: z.string().describe("Executable name, e.g. node, python3, ffmpeg."),
        version: z.boolean().optional().describe("Run --version to report the version. Default true."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        const found = which(args.name);
        if (!found) return fail(`"${args.name}" was not found on PATH.`);
        let extra = "";
        if (args.version !== false) {
          const result = await runCommand(found, ["--version"], { host: true, timeoutMs: 10_000 });
          const text = (result.stdout + result.stderr).trim().split("\n")[0] ?? "";
          if (text) extra = `\nversion: ${text}`;
        }
        return ok(`path: ${found}${extra}`);
      }),
  );

  server.registerTool(
    "current_time",
    {
      title: "Current time",
      description: "Current date and time in local and UTC form, plus the IANA timezone.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      guard(async () => {
        const now = new Date();
        return ok(
          [
            `local:    ${now.toString()}`,
            `iso:      ${now.toISOString()}`,
            `unix:     ${Math.floor(now.getTime() / 1000)}`,
            `timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
          ].join("\n"),
        );
      }),
  );
}

export const systemToolNames = [
  "system_info",
  "disk_usage",
  "env_vars",
  "clipboard_read",
  "clipboard_write",
  "screenshot",
  "notify",
  "open_url",
  "listening_ports",
  "which_command",
  "current_time",
];
