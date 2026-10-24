import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runCommand } from "../lib/exec.js";
import { fail, guard, humanBytes, ok } from "../lib/format.js";
import { resolveInside, sandboxRoot, toRelative } from "../lib/sandbox.js";

function hashBuffer(buffer: Buffer, algorithm: "sha256" | "sha1" | "md5"): string {
  return createHash(algorithm).update(buffer).digest("hex");
}

/** Tiny JSON path evaluator: a.b[0].c, a.*.id, a[*].id */
function queryJson(value: unknown, expression: string): unknown {
  if (!expression.trim()) return value;

  const tokens: Array<string | number | "*"> = [];
  for (const part of expression.replace(/^\./, "").split(".")) {
    if (!part) continue;
    const match = part.match(/^([^[\]]*)((?:\[[^\]]*\])*)$/);
    if (!match) {
      tokens.push(part);
      continue;
    }
    const [, key, brackets] = match;
    if (key) tokens.push(/^\d+$/.test(key) ? Number(key) : key);
    if (brackets) {
      const inner = brackets.match(/\[([^\]]*)\]/g) ?? [];
      for (const raw of inner) {
        const content = raw.slice(1, -1).trim().replace(/^["']|["']$/g, "");
        if (content === "*" || content === "") tokens.push("*");
        else if (/^\d+$/.test(content)) tokens.push(Number(content));
        else tokens.push(content);
      }
    }
  }

  let current: unknown = value;
  for (const token of tokens) {
    if (current === null || current === undefined) return undefined;
    if (token === "*") {
      if (Array.isArray(current)) return current.map((item) => queryJson(item, ""));
      if (typeof current === "object") return current;
      return undefined;
    }
    if (Array.isArray(current) && typeof token === "number") {
      current = current[token];
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[String(token)];
    } else {
      return undefined;
    }
  }
  return current;
}

export function registerDataTools(server: McpServer): void {
  server.registerTool(
    "diff_files",
    {
      title: "Diff two files",
      description: "Unified diff between two files inside the sandbox.",
      inputSchema: {
        a: z.string().describe("First file (or a directory)."),
        b: z.string().describe("Second file (or a directory)."),
        context: z.number().int().min(0).max(20).optional().describe("Context lines. Default 3."),
        ignore_whitespace: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        const a = resolveInside(args.a);
        const b = resolveInside(args.b);
        const argv = ["-u", `-U${args.context ?? 3}`];
        if (args.ignore_whitespace) argv.push("-w");
        argv.push(a, b);
        const result = await runCommand("diff", argv, { timeoutMs: 30_000 });
        if (result.exitCode === 0) return ok("Files are identical.");
        if (result.exitCode === 1) {
          return ok(result.stdout.replace(new RegExp(a, "g"), toRelative(a)).replace(new RegExp(b, "g"), toRelative(b)).trim());
        }
        return fail(result.stderr || `diff exited ${result.exitCode}`);
      }),
  );

  server.registerTool(
    "hash",
    {
      title: "Hash data",
      description: "Compute MD5, SHA-1 or SHA-256 for a file or a text string.",
      inputSchema: {
        algorithm: z.enum(["sha256", "sha1", "md5"]).optional().describe("Default sha256."),
        path: z.string().optional().describe("File to hash."),
        text: z.string().optional().describe("Text to hash (used when path is omitted)."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        const algorithm = args.algorithm ?? "sha256";
        if (args.path) {
          const file = resolveInside(args.path);
          return ok(`${algorithm} ${hashBuffer(await fsp.readFile(file), algorithm)}  ${toRelative(file)}`);
        }
        return ok(`${algorithm} ${hashBuffer(Buffer.from(args.text ?? "", "utf8"), algorithm)}`);
      }),
  );

  server.registerTool(
    "base64",
    {
      title: "Base64 encode / decode",
      description: "Encode text or a file to base64, or decode base64 back to text or a file.",
      inputSchema: {
        mode: z.enum(["encode", "decode"]),
        text: z.string().optional().describe("Input text (for decode: the base64 string)."),
        path: z.string().optional().describe("Input file inside the sandbox."),
        output_path: z.string().optional().describe("Write the result to this file instead of returning it."),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) =>
      guard(async () => {
        let buffer: Buffer;
        if (args.path) {
          buffer = await fsp.readFile(resolveInside(args.path));
        } else if (args.text !== undefined) {
          buffer = Buffer.from(args.text, "utf8");
        } else {
          return fail("Provide either text or path.");
        }

        const result =
          args.mode === "encode"
            ? Buffer.from(buffer.toString("base64"), "utf8")
            : Buffer.from(buffer.toString("utf8").trim(), "base64");

        if (args.output_path) {
          const target = resolveInside(args.output_path);
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await fsp.writeFile(target, result);
          return ok(`Wrote ${humanBytes(result.length)} → ${toRelative(target)}`);
        }

        const text = result.toString("utf8");
        return ok(text.length > 50_000 ? `${text.slice(0, 50_000)}\n… [${text.length - 50_000} chars cut]` : text);
      }),
  );

  server.registerTool(
    "archive",
    {
      title: "Create / extract archive",
      description:
        "Create or extract zip and tar archives inside the sandbox using the system tar/zip tools. " +
        "Paths are always relative to the sandbox root.",
      inputSchema: {
        action: z.enum(["create", "extract", "list"]),
        format: z.enum(["zip", "tar.gz", "tar"]).optional().describe("Default inferred from the archive name."),
        archive: z.string().describe("Archive file path relative to the sandbox root."),
        paths: z.array(z.string()).optional().describe("Files/folders to include when creating (default: current directory)."),
        destination: z.string().optional().describe("Extract into this folder. Default the archive's directory."),
        exclude: z.array(z.string()).optional().describe("Glob patterns to exclude when creating."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) =>
      guard(async () => {
        const archive = resolveInside(args.archive);
        const format =
          args.format ??
          (args.archive.endsWith(".zip") ? "zip" : args.archive.endsWith(".tar") ? "tar" : "tar.gz");

        if (args.action === "create") {
          await fsp.mkdir(path.dirname(archive), { recursive: true });
          const targets = args.paths?.length ? args.paths : ["."];
          const excludeArgs = (args.exclude ?? []).flatMap((pattern) => ["--exclude", pattern]);

          const argv =
            format === "zip"
              ? ["-r", archive, ...targets, ...(args.exclude ?? []).flatMap((e) => ["-x", e])]
              : ["-czf", archive, ...(format === "tar" ? [] : []), ...excludeArgs, ...targets];

          if (format === "tar") {
            argv.splice(0, argv.length, "-cf", archive, ...excludeArgs, ...targets);
          }

          const result = await runCommand(format === "zip" ? "zip" : "tar", argv, {
            cwd: sandboxRoot(),
            timeoutMs: 300_000,
          });
          if (result.exitCode !== 0) return fail(result.stderr || `archive failed (${result.exitCode})`);
          const stat = await fsp.stat(archive).catch(() => undefined);
          return ok(`Created ${toRelative(archive)} (${stat ? humanBytes(stat.size) : "?"})`);
        }

        const dest = resolveInside(args.destination ?? path.dirname(archive));
        if (args.action === "list") {
          const argv = format === "zip" ? ["-sf", archive] : ["-tf", archive];
          const result = await runCommand(format === "zip" ? "unzip" : "tar", argv, { timeoutMs: 60_000 });
          return ok(result.stdout.trim() || result.stderr.trim());
        }

        await fsp.mkdir(dest, { recursive: true });
        const argv = format === "zip" ? ["-o", archive, "-d", dest] : ["-xf", archive, "-C", dest];
        const result = await runCommand(format === "zip" ? "unzip" : "tar", argv, { timeoutMs: 300_000 });
        if (result.exitCode !== 0) return fail(result.stderr || `extract failed (${result.exitCode})`);
        return ok(`Extracted ${toRelative(archive)} → ${toRelative(dest)}`);
      }),
  );

  server.registerTool(
    "json_query",
    {
      title: "Query JSON",
      description:
        'Read JSON from a file or inline string and extract a value with a dot/bracket path, e.g. "scripts.build" or "deps[0].name". ' +
        'Use "*" to map over arrays/objects. With no path, returns the whole document pretty-printed.',
      inputSchema: {
        path: z.string().optional().describe("JSON file inside the sandbox."),
        json: z.string().optional().describe("Inline JSON text (used when path is omitted)."),
        query: z.string().optional().describe('Path expression, e.g. "items[2].title".'),
        max_chars: z.number().int().min(100).max(200_000).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        let raw: string;
        if (args.path) {
          raw = await fsp.readFile(resolveInside(args.path), "utf8");
        } else if (args.json !== undefined) {
          raw = args.json;
        } else {
          return fail("Provide either path or json.");
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (error) {
          return fail(`Invalid JSON: ${(error as Error).message}`);
        }

        const selected = args.query ? queryJson(parsed, args.query) : parsed;
        if (selected === undefined) return fail(`Path "${args.query}" did not resolve to anything.`);

        const output = typeof selected === "string" ? selected : JSON.stringify(selected, null, 2);
        const max = args.max_chars ?? 50_000;
        return ok(output.length > max ? `${output.slice(0, max)}\n… [${output.length - max} chars cut]` : output);
      }),
  );

  server.registerTool(
    "json_set",
    {
      title: "Edit JSON file",
      description:
        "Set or delete a value in a JSON file using a path (e.g. \"version\" or \"scripts.test\"). Writes pretty-printed JSON.",
      inputSchema: {
        path: z.string().describe("JSON file inside the sandbox."),
        query: z.string().describe("Path to the key, e.g. \"scripts.build\"."),
        value: z.any().optional().describe("New value (any JSON type). Omit when deleting."),
        delete: z.boolean().optional().describe("Delete the key instead of setting it."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) =>
      guard(async () => {
        const file = resolveInside(args.path);
        const parsed = JSON.parse(await fsp.readFile(file, "utf8")) as Record<string, unknown>;

        const parts = args.query.replace(/^\./, "").split(".").filter(Boolean);
        if (!parts.length) return fail("Provide a non-empty query path.");

        let cursor: Record<string, unknown> | unknown[] = parsed;
        for (let i = 0; i < parts.length - 1; i++) {
          const key = parts[i];
          const next = (cursor as Record<string, unknown>)[key];
          if (next === null || typeof next !== "object") {
            if (args.delete) return fail(`Path "${parts.slice(0, i + 1).join(".")}" does not exist.`);
            (cursor as Record<string, unknown>)[key] = {};
          }
          cursor = (cursor as Record<string, unknown>)[key] as Record<string, unknown>;
        }

        const last = parts[parts.length - 1];
        if (args.delete) {
          if (Array.isArray(cursor)) cursor.splice(Number(last), 1);
          else delete (cursor as Record<string, unknown>)[last];
        } else {
          (cursor as Record<string, unknown>)[last] = args.value;
        }

        await fsp.writeFile(file, JSON.stringify(parsed, null, 2) + "\n", "utf8");
        return ok(`${args.delete ? "Deleted" : "Set"} "${args.query}" in ${toRelative(file)}.`);
      }),
  );
}

export const dataToolNames = ["diff_files", "hash", "base64", "archive", "json_query", "json_set"];

void fs;
void path;
