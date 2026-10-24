import { spawn } from "node:child_process";
import { config } from "../config.js";
import { formatError } from "./format.js";
import { wrapArgv } from "./osSandbox.js";
import { resolveDir, sandboxEnv } from "./sandbox.js";

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  stdin?: string;
  maxChars?: number;
  /** Skip OS-sandbox wrapping (used only by fixed, host-integration helpers). */
  host?: boolean;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
  command: string;
}

function truncateMiddle(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const head = Math.floor(max * 0.7);
  const tail = Math.floor(max * 0.25);
  const dropped = text.length - head - tail;
  return {
    text:
      text.slice(0, head) +
      `\n… [${dropped.toLocaleString()} chars truncated] …\n` +
      text.slice(text.length - tail),
    truncated: true,
  };
}

function killTree(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      child.kill("SIGKILL");
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** Execute argv directly (no shell), inside the sandbox. */
export async function runCommand(
  file: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const cwd = opts.cwd ? resolveDir(opts.cwd) : resolveDir(".");
  const timeoutMs = Math.max(1000, opts.timeoutMs ?? config.defaultTimeoutMs);
  const maxChars = opts.maxChars ?? config.maxOutputChars;
  const started = Date.now();

  const wrapped = opts.host ? { file, args } : wrapArgv(file, args, cwd);

  const child = spawn(wrapped.file, wrapped.args, {
    cwd,
    env: {
      ...process.env,
      ...sandboxEnv(),
      ...(opts.env ?? {}),
      TERM: process.env.TERM ?? "xterm-256color",
    },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  let stdout = "";
  let stderr = "";
  let truncated = false;

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");

  child.stdout?.on("data", (chunk: string) => {
    if (stdout.length < maxChars * 3) stdout += chunk;
    else truncated = true;
  });
  child.stderr?.on("data", (chunk: string) => {
    if (stderr.length < maxChars * 3) stderr += chunk;
    else truncated = true;
  });

  if (opts.stdin !== undefined) {
    child.stdin?.end(opts.stdin);
  } else {
    child.stdin?.end();
  }

  const timedOut = await new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree(child);
      resolve(true);
    }, timeoutMs);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stderr += (stderr ? "\n" : "") + formatError(error);
      resolve(false);
    });

    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(false);
    });
  });

  const out = truncateMiddle(stdout, maxChars);
  const err = truncateMiddle(stderr, maxChars);

  return {
    stdout: out.text,
    stderr: err.text,
    exitCode: child.exitCode,
    signal: child.signalCode,
    timedOut,
    durationMs: Date.now() - started,
    truncated: truncated || out.truncated || err.truncated,
    command: [file, ...args].join(" "),
  };
}

/** Execute a shell command line inside the sandbox. */
export async function runShell(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
  const shell = process.env.SHELL && process.env.SHELL.startsWith("/") ? process.env.SHELL : "/bin/sh";
  return runCommand(shell, ["-c", command], opts);
}

export function renderExecResult(result: ExecResult): string {
  const lines: string[] = [];
  const status = result.timedOut
    ? "TIMEOUT"
    : result.exitCode === 0
      ? "OK"
      : `EXIT ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}`;
  lines.push(`[${status}] ${result.durationMs}ms`);
  if (result.stdout.trim()) lines.push("--- stdout ---\n" + result.stdout.replace(/\s+$/, ""));
  if (result.stderr.trim()) lines.push("--- stderr ---\n" + result.stderr.replace(/\s+$/, ""));
  if (!result.stdout.trim() && !result.stderr.trim()) lines.push("(no output)");
  if (result.truncated) lines.push("(output truncated)");
  return lines.join("\n");
}

export { which } from "./which.js";
