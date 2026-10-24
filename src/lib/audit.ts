import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

export interface AuditEntry {
  ts: string;
  tool: string;
  command?: string;
  cwd?: string;
  exitCode?: number | null;
  durationMs?: number;
  detail?: string;
}

const MAX_AUDIT_BYTES = 5 * 1024 * 1024;

export async function logAudit(entry: AuditEntry): Promise<void> {
  const line = JSON.stringify(entry) + "\n";
  try {
    await fsp.mkdir(path.dirname(config.auditPath), { recursive: true });
    await fsp.appendFile(config.auditPath, line, "utf8");
    const stat = await fsp.stat(config.auditPath);
    if (stat.size > MAX_AUDIT_BYTES) {
      const content = await fsp.readFile(config.auditPath, "utf8");
      const keep = content.slice(content.length - Math.floor(MAX_AUDIT_BYTES / 2));
      const firstNewline = keep.indexOf("\n");
      await fsp.writeFile(config.auditPath, keep.slice(firstNewline + 1), "utf8");
    }
  } catch {
    // Auditing must never break a tool call.
  }
}

export async function readAudit(limit = 50, tool?: string): Promise<AuditEntry[]> {
  if (!fs.existsSync(config.auditPath)) return [];
  const content = await fsp.readFile(config.auditPath, "utf8");
  const lines = content.split("\n").filter(Boolean);
  const entries: AuditEntry[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as AuditEntry;
      if (!tool || parsed.tool === tool) entries.push(parsed);
    } catch {
      /* skip malformed line */
    }
  }
  return entries.slice(-Math.max(1, limit));
}

export async function clearAudit(): Promise<void> {
  await fsp.writeFile(config.auditPath, "", "utf8");
}
