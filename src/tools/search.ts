import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, guard, ok } from "../lib/format.js";
import { globToRegExp, humanSize, walk } from "../lib/fsutil.js";
import { resolveDir, resolveInside, sandboxRoot, toRelative } from "../lib/sandbox.js";

const MAX_FILE_BYTES = 2 * 1024 * 1024;

interface Candidate {
  absolute: string;
  relative: string;
}

function collectFiles(
  root: string,
  options: { glob?: string; includeHidden?: boolean; maxFiles?: number },
): Candidate[] {
  const regex = options.glob ? globToRegExp(options.glob) : undefined;
  const entries = walk(root, { maxDepth: 24, includeHidden: options.includeHidden ?? true });
  const files: Candidate[] = [];

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (regex && !regex.test(entry.relative.split(path.sep).join("/"))) continue;
    files.push({ absolute: entry.absolute, relative: entry.relative });
    if (files.length >= (options.maxFiles ?? 20_000)) break;
  }
  return files;
}

function isProbablyBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 4000).includes(0);
}

export function registerSearchTools(server: McpServer): void {
  server.registerTool(
    "find_files",
    {
      title: "Find files by name",
      description:
        'Find files and folders whose path matches a glob. Supports *, **, ? and {a,b}. Example: "**/*.test.ts".',
      inputSchema: {
        pattern: z.string().describe('Glob pattern, e.g. "**/*.ts" or "src/**/config.{js,ts}".'),
        path: z.string().optional().describe("Directory to search from. Defaults to the sandbox root."),
        include_dirs: z.boolean().optional().describe("Also return matching directories."),
        include_hidden: z.boolean().optional(),
        max_results: z.number().int().min(1).max(5000).optional().describe("Default 300."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        const root = resolveDir(args.path ?? ".");
        const regex = globToRegExp(args.pattern);
        const max = args.max_results ?? 300;
        const entries = walk(root, { maxDepth: 24, includeHidden: args.include_hidden ?? true });
        const matches = entries
          .filter((e) => args.include_dirs || !e.isDirectory)
          .filter((e) => regex.test(path.relative(root, e.absolute).split(path.sep).join("/")) || regex.test(e.name))
          .slice(0, max);

        if (!matches.length) return ok(`No matches for ${args.pattern} under ${toRelative(root)}.`);

        return ok(
          `${matches.length} match(es) for ${args.pattern} in ${toRelative(root)}:\n` +
            matches.map((m) => `${m.relative}${m.isDirectory ? "/" : ""}  ${m.isDirectory ? "" : humanSize(m.size)}`).join("\n"),
        );
      }),
  );

  server.registerTool(
    "search_text",
    {
      title: "Search text in files",
      description:
        "Search file contents with a regular expression (or literal string). Returns file, line number, matching line " +
        "and optional surrounding context. Binary and oversized files are skipped.",
      inputSchema: {
        query: z.string().min(1).describe("Text or regular expression to search for."),
        path: z.string().optional().describe("Directory (or single file) to search. Defaults to the sandbox root."),
        glob: z.string().optional().describe('Restrict to files matching this glob, e.g. "**/*.ts".'),
        literal: z.boolean().optional().describe("Treat query as plain text instead of a regex. Default false."),
        case_sensitive: z.boolean().optional().describe("Default false."),
        context_lines: z.number().int().min(0).max(10).optional().describe("Lines of context around each hit. Default 0."),
        max_results: z.number().int().min(1).max(2000).optional().describe("Default 100."),
        include_hidden: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        let regex: RegExp;
        try {
          const source = args.literal ? args.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : args.query;
          regex = new RegExp(source, args.case_sensitive ? "g" : "gi");
        } catch (error) {
          return fail(`Invalid pattern: ${(error as Error).message}`);
        }

        const target = resolveInside(args.path ?? ".");
        const stat = await fsp.stat(target).catch(() => undefined);
        if (!stat) return fail(`Path not found: ${toRelative(target)}`);

        const files: Candidate[] = stat.isFile()
          ? [{ absolute: target, relative: toRelative(target) }]
          : collectFiles(target, { glob: args.glob, includeHidden: args.include_hidden });

        const max = args.max_results ?? 100;
        const contextLines = args.context_lines ?? 0;
        const hits: string[] = [];
        let totalHits = 0;
        let scanned = 0;

        for (const file of files) {
          if (hits.length >= max) break;
          const fileStat = fs.statSync(file.absolute, { throwIfNoEntry: false });
          if (!fileStat || fileStat.size > MAX_FILE_BYTES) continue;

          let buffer: Buffer;
          try {
            buffer = await fsp.readFile(file.absolute);
          } catch {
            continue;
          }
          if (isProbablyBinary(buffer)) continue;

          scanned++;
          const lines = buffer.toString("utf8").split("\n");
          for (let i = 0; i < lines.length; i++) {
            regex.lastIndex = 0;
            if (!regex.test(lines[i])) continue;
            totalHits++;
            const from = Math.max(0, i - contextLines);
            const to = Math.min(lines.length - 1, i + contextLines);
            const snippet: string[] = [];
            for (let j = from; j <= to; j++) {
              const marker = j === i ? ">" : " ";
              snippet.push(`${marker} ${file.relative}:${j + 1}: ${lines[j].slice(0, 400)}`);
            }
            hits.push(snippet.join("\n"));
            if (hits.length >= max) break;
          }
        }

        if (!hits.length) return ok(`No matches for ${args.query} (scanned ${scanned} files).`);
        return ok(
          `${totalHits} match(es) in ${scanned} scanned file(s)${hits.length >= max ? ` — showing first ${max}` : ""}:\n\n` +
            hits.join("\n"),
        );
      }),
  );

  server.registerTool(
    "replace_text",
    {
      title: "Bulk find & replace",
      description:
        "Replace text across multiple files. Defaults to a dry run that only reports what would change — " +
        "set dry_run=false to write. Supports regex capture groups ($1, $2).",
      inputSchema: {
        query: z.string().min(1).describe("Regex (or literal text) to find."),
        replacement: z.string().describe("Replacement text; $1/$2 refer to capture groups when using regex."),
        path: z.string().optional().describe("Directory to operate on. Defaults to the sandbox root."),
        glob: z.string().optional().describe('File filter, e.g. "**/*.ts".'),
        literal: z.boolean().optional().describe("Treat query as plain text. Default false."),
        case_sensitive: z.boolean().optional(),
        dry_run: z.boolean().optional().describe("Preview changes without writing. Default true."),
        max_files: z.number().int().min(1).max(2000).optional().describe("Default 200."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) =>
      guard(async () => {
        let regex: RegExp;
        try {
          const source = args.literal ? args.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : args.query;
          regex = new RegExp(source, args.case_sensitive ? "g" : "gi");
        } catch (error) {
          return fail(`Invalid pattern: ${(error as Error).message}`);
        }

        const root = resolveDir(args.path ?? ".");
        const files = collectFiles(root, { glob: args.glob });
        const dryRun = args.dry_run !== false;
        const maxFiles = args.max_files ?? 200;

        const changed: string[] = [];
        let replacements = 0;

        for (const file of files) {
          if (changed.length >= maxFiles) break;
          const stat = fs.statSync(file.absolute, { throwIfNoEntry: false });
          if (!stat || stat.size > MAX_FILE_BYTES) continue;

          let buffer: Buffer;
          try {
            buffer = await fsp.readFile(file.absolute);
          } catch {
            continue;
          }
          if (isProbablyBinary(buffer)) continue;

          const original = buffer.toString("utf8");
          regex.lastIndex = 0;
          const matches = original.match(regex);
          if (!matches?.length) continue;

          const updated = original.replace(regex, args.replacement);
          replacements += matches.length;
          changed.push(`${file.relative} (${matches.length} replacement${matches.length === 1 ? "" : "s"})`);
          if (!dryRun) await fsp.writeFile(file.absolute, updated, "utf8");
        }

        if (!changed.length) return ok("No matches found; nothing to replace.");
        return ok(
          (dryRun ? "DRY RUN — no files were modified.\n" : "Files updated.\n") +
            `${replacements} replacement(s) across ${changed.length} file(s):\n` +
            changed.join("\n"),
        );
      }),
  );

  server.registerTool(
    "count_lines",
    {
      title: "Count lines / words",
      description: "Report line, word and character counts for files or an entire directory.",
      inputSchema: {
        path: z.string().optional().describe("File or directory. Defaults to the sandbox root."),
        glob: z.string().optional().describe("When path is a directory, only count files matching this glob."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        const target = resolveInside(args.path ?? ".");
        const stat = await fsp.stat(target).catch(() => undefined);
        if (!stat) return fail(`Path not found: ${toRelative(target)}`);

        const files = stat.isFile()
          ? [{ absolute: target, relative: toRelative(target) }]
          : collectFiles(target, { glob: args.glob });

        let lines = 0;
        let words = 0;
        let chars = 0;
        let counted = 0;

        for (const file of files) {
          const fileStat = fs.statSync(file.absolute, { throwIfNoEntry: false });
          if (!fileStat || fileStat.size > MAX_FILE_BYTES) continue;
          const buffer = await fsp.readFile(file.absolute).catch(() => undefined);
          if (!buffer || isProbablyBinary(buffer)) continue;
          const text = buffer.toString("utf8");
          lines += text.split("\n").length;
          words += text.split(/\s+/).filter(Boolean).length;
          chars += text.length;
          counted++;
        }

        return ok(
          `${counted} file(s)\nlines:      ${lines.toLocaleString()}\nwords:      ${words.toLocaleString()}\ncharacters: ${chars.toLocaleString()}`,
        );
      }),
  );

  void sandboxRoot;
}

export const searchToolNames = ["find_files", "search_text", "replace_text", "count_lines"];
