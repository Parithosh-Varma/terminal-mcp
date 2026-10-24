import { spawn, type ChildProcess } from "node:child_process";
import { config } from "../config.js";
import { scrubEnv } from "./env.js";
import { wrapArgv } from "./osSandbox.js";
import { resolveDir, sandboxEnv, toRelative } from "./sandbox.js";

export interface ManagedProcess {
  id: string;
  command: string;
  cwd: string;
  child: ChildProcess;
  stdout: string;
  stderr: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  truncated: boolean;
}

const MAX_BUFFER = 1_500_000;
const registry = new Map<string, ManagedProcess>();
let counter = 0;

export function startManaged(
  command: string,
  options: { cwd?: string; name?: string } = {},
): ManagedProcess {
  const cwd = resolveDir(options.cwd ?? ".");
  const shell = process.env.SHELL && process.env.SHELL.startsWith("/") ? process.env.SHELL : "/bin/sh";
  const wrapped = wrapArgv(shell, ["-c", command], cwd);

  const { env: baseEnv } = scrubEnv(process.env);
  const child = spawn(wrapped.file, wrapped.args, {
    cwd,
    env: { ...baseEnv, ...sandboxEnv(), TERM: process.env.TERM ?? "xterm-256color" },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  const id = options.name?.trim() || `proc-${++counter}`;
  const managed: ManagedProcess = {
    id,
    command,
    cwd: toRelative(cwd),
    child,
    stdout: "",
    stderr: "",
    startedAt: Date.now(),
    truncated: false,
  };

  const append = (target: "stdout" | "stderr") => (chunk: Buffer) => {
    const current = managed[target];
    if (current.length + chunk.length > MAX_BUFFER) {
      managed[target] = current.slice(-Math.floor(MAX_BUFFER / 2)) + chunk.toString("utf8");
      managed.truncated = true;
    } else {
      managed[target] = current + chunk.toString("utf8");
    }
  };

  child.stdout?.on("data", append("stdout"));
  child.stderr?.on("data", append("stderr"));

  child.on("close", (code, signal) => {
    managed.exitCode = code;
    managed.signal = signal;
    managed.endedAt = Date.now();
  });

  child.on("error", (error) => {
    managed.stderr += `\n[spawn error] ${error.message}`;
    managed.endedAt = Date.now();
  });

  registry.set(id, managed);
  return managed;
}

export function getManaged(id: string): ManagedProcess | undefined {
  return registry.get(id);
}

export function listManaged(): ManagedProcess[] {
  return [...registry.values()].sort((a, b) => a.startedAt - b.startedAt);
}

export function isRunning(proc: ManagedProcess): boolean {
  return proc.endedAt === undefined;
}

export function readManaged(
  id: string,
  options: { offset?: number; stream?: "stdout" | "stderr" | "both" } = {},
): { output: string; offset: number; running: boolean; exitCode?: number | null } | undefined {
  const proc = registry.get(id);
  if (!proc) return undefined;

  const combined =
    options.stream === "stderr"
      ? proc.stderr
      : options.stream === "stdout"
        ? proc.stdout
        : [proc.stdout, proc.stderr].filter(Boolean).join("\n");

  const offset = Math.max(0, Math.min(options.offset ?? 0, combined.length));
  let output = combined.slice(offset);
  if (output.length > config.maxOutputChars) {
    output = output.slice(-config.maxOutputChars);
  }

  return {
    output,
    offset: combined.length,
    running: isRunning(proc),
    exitCode: proc.exitCode,
  };
}

export function writeManaged(id: string, input: string): boolean {
  const proc = registry.get(id);
  if (!proc || !proc.child.stdin || proc.child.stdin.destroyed) return false;
  proc.child.stdin.write(input);
  return true;
}

export function killManaged(id: string, signal: NodeJS.Signals = "SIGTERM"): boolean {
  const proc = registry.get(id);
  if (!proc) return false;
  try {
    if (process.platform !== "win32" && proc.child.pid) {
      process.kill(-proc.child.pid, signal);
    } else {
      proc.child.kill(signal);
    }
    return true;
  } catch {
    return false;
  }
}

export async function waitManaged(id: string, timeoutMs = 30_000): Promise<boolean> {
  const proc = registry.get(id);
  if (!proc) return false;
  if (!isRunning(proc)) return true;
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    proc.child.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export function pruneManaged(): number {
  let removed = 0;
  for (const [id, proc] of registry) {
    if (!isRunning(proc) && proc.endedAt && Date.now() - proc.endedAt > 30 * 60_000) {
      registry.delete(id);
      removed++;
    }
  }
  return removed;
}
