import fs from "node:fs";
import path from "node:path";
import { resolveInside, toRelative } from "./sandbox.js";

export interface WalkEntry {
  absolute: string;
  relative: string;
  name: string;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  mtimeMs: number;
}

export interface WalkOptions {
  maxDepth?: number;
  includeHidden?: boolean;
  followSymlinks?: boolean;
  skipDirs?: string[];
}

export const DEFAULT_SKIP_DIRS = [
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".cache",
  "dist",
  "build",
  "target",
  ".turbo",
  ".terraform",
];

/**
 * Breadth-first directory walk confined to the sandbox.
 * Symlinks are reported but never traversed unless explicitly allowed and
 * verified to remain inside the sandbox.
 */
export function walk(start: string, options: WalkOptions = {}): WalkEntry[] {
  const root = resolveInside(start);
  const maxDepth = options.maxDepth ?? 20;
  const includeHidden = options.includeHidden ?? true;
  const skip = new Set(options.skipDirs ?? DEFAULT_SKIP_DIRS);
  const results: WalkEntry[] = [];

  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length) {
    const current = queue.shift()!;
    if (current.depth > maxDepth) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!includeHidden && entry.name.startsWith(".")) continue;

      const absolute = path.join(current.dir, entry.name);
      let isDirectory = entry.isDirectory();
      const isSymlink = entry.isSymbolicLink();

      let size = 0;
      let mtimeMs = 0;
      try {
        const stat = fs.statSync(absolute, { throwIfNoEntry: false });
        if (stat) {
          size = stat.size;
          mtimeMs = stat.mtimeMs;
        }
      } catch {
        /* broken link */
      }

      if (isDirectory && skip.has(entry.name)) continue;

      results.push({
        absolute,
        relative: toRelative(absolute),
        name: entry.name,
        isDirectory,
        isSymlink,
        size,
        mtimeMs,
      });

      if (isDirectory && current.depth < maxDepth) {
        if (options.followSymlinks || !isSymlink) {
          queue.push({ dir: absolute, depth: current.depth + 1 });
        }
      }
    }
  }

  results.sort((a, b) => a.relative.localeCompare(b.relative));
  return results;
}

/** Convert a glob (supporting *, **, ?, and {a,b}) into a RegExp. */
export function globToRegExp(glob: string): RegExp {
  let pattern = glob.replace(/\\/g, "/");
  let out = "^";

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        const afterSlash = pattern[i + 2] === "/";
        out += afterSlash ? "(?:.*/)?" : ".*";
        i += afterSlash ? 2 : 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "{") {
      const close = pattern.indexOf("}", i);
      if (close === -1) {
        out += "\\{";
      } else {
        const options = pattern.slice(i + 1, close).split(",");
        out += "(?:" + options.map((o) => o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")";
        i = close;
      }
    } else if ("+^$()[]|.\\".includes(char)) {
      out += "\\" + char;
    } else {
      out += char;
    }
  }

  out += "$";
  try {
    return new RegExp(out, "i");
  } catch {
    return new RegExp("^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i");
  }
}

export function describeEntry(entry: WalkEntry): string {
  const kind = entry.isSymlink ? "link" : entry.isDirectory ? "dir " : "file";
  return `${kind}  ${entry.relative}${entry.isDirectory ? "/" : ""}`;
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)}${units[i]}`;
}

/** Ensure we never walk outside the sandbox even through symlinked dirs. */
export function assertInsideRoot(absolute: string): void {
  resolveInside(absolute);
}
