import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { sandboxRoot } from "./sandbox.js";

export type OsSandboxKind = "sandbox-exec" | "bwrap" | "none";

export interface OsSandboxStatus {
  kind: OsSandboxKind;
  available: boolean;
  detail: string;
}

function which(bin: string): string | undefined {
  const paths = (process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(path.delimiter);
  for (const dir of paths) {
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

let cachedStatus: OsSandboxStatus | undefined;

export function osSandboxStatus(): OsSandboxStatus {
  if (cachedStatus) return cachedStatus;

  if (config.mode !== "strict") {
    cachedStatus = { kind: "none", available: false, detail: `mode is "${config.mode}"` };
    return cachedStatus;
  }

  if (process.platform === "darwin") {
    const bin = fs.existsSync("/usr/bin/sandbox-exec") ? "/usr/bin/sandbox-exec" : which("sandbox-exec");
    cachedStatus = bin
      ? { kind: "sandbox-exec", available: true, detail: bin }
      : {
          kind: "none",
          available: false,
          detail: "sandbox-exec not found (deprecated/removed on this macOS build)",
        };
    return cachedStatus;
  }

  if (process.platform === "linux") {
    const bin = which("bwrap");
    cachedStatus = bin
      ? { kind: "bwrap", available: true, detail: bin }
      : { kind: "none", available: false, detail: "bwrap not found (install bubblewrap)" };
    return cachedStatus;
  }

  cachedStatus = { kind: "none", available: false, detail: `unsupported platform ${process.platform}` };
  return cachedStatus;
}

const SENSITIVE_READ_DENY = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker/config.json",
  ".config/gh",
  ".netrc",
  ".npmrc",
  ".pypirc",
];

function sandboxProfile(root: string): string {
  const home = os.homedir();
  const tmp = os.tmpdir();

  const denyReads = SENSITIVE_READ_DENY.map((p) => `  (subpath "${path.join(home, p)}")`).join("\n");
  const allowWrites = [
    `  (subpath "${root}")`,
    `  (subpath "${tmp}")`,
    `  (subpath "/private/tmp")`,
    `  (literal "/dev/null")`,
    `  (literal "/dev/stdout")`,
    `  (literal "/dev/stderr")`,
    `  (literal "/dev/tty")`,
    `  (literal "/dev/dtracehelper")`,
    ...config.extraWritePaths.map((p) => `  (subpath "${path.resolve(p)}")`),
  ].join("\n");

  const allowReads = config.extraReadPaths.map((p) => `  (subpath "${path.resolve(p)}")`).join("\n");

  return `(version 1)
(deny default)
(allow process*)
(allow signal)
(allow sysctl-read)
(allow mach-lookup)
(allow ipc-posix-shm)
(allow file-read*)
(deny file-read*
${denyReads})
(allow file-read*
  (subpath "${root}")
${allowReads})
(allow file-write*
${allowWrites})
${config.allowNetwork ? "(allow network*)" : "(deny network*)"}
`;
}

let profilePath: string | undefined;

function macProfileFile(): string {
  if (profilePath && fs.existsSync(profilePath)) return profilePath;
  const root = sandboxRoot();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-mcp-"));
  const file = path.join(dir, "sandbox.sb");
  fs.writeFileSync(file, sandboxProfile(root), { mode: 0o600 });
  profilePath = file;
  return file;
}

/**
 * Wrap a fully-formed argv so it executes inside the OS sandbox.
 * Returns the argv unchanged when no OS-level sandbox is available.
 */
export function wrapArgv(
  file: string,
  args: string[],
  cwd: string,
): { file: string; args: string[] } {
  const status = osSandboxStatus();
  if (!status.available) return { file, args };

  if (status.kind === "sandbox-exec") {
    return { file: "/usr/bin/sandbox-exec", args: ["-f", macProfileFile(), file, ...args] };
  }

  if (status.kind === "bwrap") {
    const root = sandboxRoot();
    const bwrapArgs = [
      "--die-with-parent",
      "--ro-bind",
      "/",
      "/",
      "--bind",
      root,
      root,
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
      "--chdir",
      cwd,
    ];
    if (!config.allowNetwork) bwrapArgs.push("--unshare-net");
    bwrapArgs.push(file, ...args);
    return { file: "bwrap", args: bwrapArgs };
  }

  return { file, args };
}
