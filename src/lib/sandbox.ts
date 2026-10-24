import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export class SandboxViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxViolation";
  }
}

let realRoot = "";

/** Resolve the sandbox root (following symlinks) once at startup. */
export function initSandbox(): string {
  fs.mkdirSync(config.root, { recursive: true });
  realRoot = fs.realpathSync.native(config.root);
  return realRoot;
}

export function sandboxRoot(): string {
  if (!realRoot) initSandbox();
  return realRoot;
}

export function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * Resolve a user-supplied path against the sandbox root and guarantee that the
 * *real* location (after symlink resolution) stays inside the sandbox.
 */
export function resolveInside(input?: string): string {
  if (config.mode === "off") {
    const raw = (input ?? "").trim() || ".";
    return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(config.root, raw);
  }

  const root = sandboxRoot();
  const raw = (input ?? "").trim() || ".";
  const absolute = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root, raw);

  // Walk up to the nearest existing ancestor so we can resolve symlinks even
  // when the target does not exist yet.
  let cursor = absolute;
  const missingTail: string[] = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missingTail.unshift(path.basename(cursor));
    cursor = parent;
  }

  let resolvedCursor: string;
  try {
    resolvedCursor = fs.realpathSync.native(cursor);
  } catch {
    resolvedCursor = cursor;
  }

  const resolved = missingTail.length ? path.join(resolvedCursor, ...missingTail) : resolvedCursor;

  if (!isInside(root, resolved)) {
    throw new SandboxViolation(
      `Path escapes the sandbox: ${input}\n` +
        `Sandbox root: ${root}\n` +
        `Resolved to:  ${resolved}\n` +
        `All file access is confined to the sandbox root.`,
    );
  }

  return resolved;
}

/** Path relative to the sandbox root, for display. */
export function toRelative(absolute: string): string {
  const rel = path.relative(sandboxRoot(), absolute);
  if (!rel) return ".";
  return rel.startsWith("..") ? absolute : rel;
}

/** Resolve a directory that must already exist. */
export function resolveDir(input?: string): string {
  const dir = resolveInside(input);
  const stat = fs.statSync(dir, { throwIfNoEntry: false });
  if (!stat) throw new SandboxViolation(`Directory does not exist: ${toRelative(dir)}`);
  if (!stat.isDirectory()) throw new SandboxViolation(`Not a directory: ${toRelative(dir)}`);
  return dir;
}

/** Environment overlay applied to every sandboxed command. */
export function sandboxEnv(): NodeJS.ProcessEnv {
  if (config.mode !== "strict") return {};
  const tmp = path.join(sandboxRoot(), ".tmp");
  fs.mkdirSync(tmp, { recursive: true });
  return {
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    XDG_CACHE_HOME: path.join(sandboxRoot(), ".cache"),
    npm_config_cache: path.join(sandboxRoot(), ".npm-cache"),
  };
}

export function sandboxSummary(): string {
  return [
    `root:  ${sandboxRoot()}`,
    `mode:  ${config.mode}`,
    `net:   ${config.allowNetwork ? "allowed" : "denied"}`,
  ].join("\n");
}
