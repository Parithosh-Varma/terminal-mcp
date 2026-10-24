import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

/**
 * One sandbox directory per client session: sand1, sand2, …
 *
 * HTTP: every MCP session (every new chat) gets its own directory, tracked by
 * Mcp-Session-Id. The active session travels with the request through
 * AsyncLocalStorage, so concurrent sessions never collide.
 *
 * stdio: a process is a session, so it gets exactly one directory.
 *
 * Directories are allocated lazily — on the first tool that actually touches
 * the filesystem. Health checks and `tools/list` therefore leave no folders
 * behind; sandN only appears once a session does real work.
 */
export interface SandboxSession {
  /** "sand1", "sand2", … — null until the session does real work. */
  label: string | null;
  /** Absolute path — null until allocated. */
  dir: string | null;
  /** MCP session id, when there is one. */
  id: string | null;
  /** ISO timestamp of the session. */
  createdAt: string;
  /** ISO timestamp of the first filesystem access. */
  allocatedAt: string | null;
}

const storage = new AsyncLocalStorage<SandboxSession>();
const byId = new Map<string, SandboxSession>();

/** Used by stdio, where the whole process is a single session. */
let single: SandboxSession | null = null;

export function createSession(id: string | null = null): SandboxSession {
  const session: SandboxSession = {
    label: null,
    dir: null,
    id,
    createdAt: new Date().toISOString(),
    allocatedAt: null,
  };
  if (id) byId.set(id, session);
  return session;
}

export function setSingleSession(session: SandboxSession): void {
  single = session;
}

export function currentSession(): SandboxSession | null {
  return storage.getStore() ?? single;
}

/** Root used by every path check: the session dir, or the shared root. */
export function currentRoot(): string {
  const session = currentSession();
  if (!session) return config.root;
  return ensureDir(session);
}

function allocateDir(): string {
  fs.mkdirSync(config.home, { recursive: true });
  for (let i = 1; i <= 10_000; i++) {
    const dir = path.join(config.home, `sand${i}`);
    try {
      // Non-recursive mkdir is atomic: EEXIST means the slot is taken.
      fs.mkdirSync(dir);
      return dir;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error(`No free sandbox slot (sand1…) left in ${config.home}`);
}

function ensureDir(session: SandboxSession): string {
  if (session.dir) return session.dir;
  const dir = allocateDir();
  session.dir = dir;
  session.label = path.basename(dir);
  session.allocatedAt = new Date().toISOString();
  record(session);
  return dir;
}

function record(session: SandboxSession): void {
  try {
    fs.appendFileSync(
      path.join(config.stateDir, "sessions.jsonl"),
      JSON.stringify(session) + "\n",
      { mode: 0o600 },
    );
  } catch {
    // Never let bookkeeping break a session.
  }
}

export function runInSession<T>(session: SandboxSession, fn: () => T): T {
  return storage.run(session, fn);
}

export function bindSession(id: string, session: SandboxSession): void {
  session.id = id;
  byId.set(id, session);
  if (session.dir) record(session);
}

export function sessionFor(id: string): SandboxSession | undefined {
  return byId.get(id);
}

/** Every sandX directory that exists on disk, oldest first. */
export function listSandboxes(): Array<{ label: string; dir: string; mtime: Date }> {
  let entries: string[];
  try {
    entries = fs.readdirSync(config.home);
  } catch {
    return [];
  }
  return entries
    .filter((name) => /^sand\d+$/.test(name))
    .map((name) => {
      const dir = path.join(config.home, name);
      return { label: name, dir, mtime: fs.statSync(dir).mtime };
    })
    .sort((a, b) => a.mtime.getTime() - b.mtime.getTime());
}
