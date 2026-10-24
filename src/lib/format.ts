import { config } from "../config.js";

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function ok(text: string): ToolResult {
  return { content: [{ type: "text", text: cap(text) }] };
}

export function fail(text: string): ToolResult {
  return { content: [{ type: "text", text: cap(text) }], isError: true };
}

export function cap(text: string, max = config.maxOutputChars): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.65);
  const tail = Math.floor(max * 0.3);
  const dropped = text.length - head - tail;
  return (
    text.slice(0, head) +
    `\n\n… [${dropped.toLocaleString()} characters truncated of ${text.length.toLocaleString()} total] …\n\n` +
    text.slice(text.length - tail)
  );
}

export function humanBytes(n: number): string {
  if (!Number.isFinite(n)) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    const anyErr = error as Error & { code?: string; status?: number };
    const bits = [anyErr.message];
    if (anyErr.code) bits.push(`code=${anyErr.code}`);
    if (anyErr.status) bits.push(`status=${anyErr.status}`);
    return bits.join(" | ");
  }
  return String(error);
}

/** Run a tool body, converting thrown errors into MCP tool errors. */
export async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (error) {
    return fail(formatError(error));
  }
}

export function bulletList(lines: string[]): string {
  return lines.map((l) => `- ${l}`).join("\n");
}
