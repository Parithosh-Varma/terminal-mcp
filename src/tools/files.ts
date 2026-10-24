import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { guard, ok, fail, humanBytes } from "../lib/format.js";
import { DEFAULT_SKIP_DIRS, walk } from "../lib/fsutil.js";
import { resolveDir, resolveInside, toRelative } from "../lib/sandbox.js";

const pathArg = z.string().describe("Path relative to the sandbox root (absolute paths inside the sandbox also work).");

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8000);
  return sample.includes(0);
}

async function sha256(file: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

export function registerFileTools(server: McpServer): void {
  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description:
        "Read a text file from the sandbox. Supports line ranges for large files. Binary files are reported as such " +
        "(set as_base64 to get the raw bytes).",
      inputSchema: {
        path: pathArg,
        offset: z.number().int().min(1).optional().describe("First line to read (1-based). Default 1."),
        limit: z.number().int().min(1).max(20_000).optional().describe("Maximum number of lines to return."),
        line_numbers: z.boolean().optional().describe("Prefix each line with its line number."),
        as_base64: z.boolean().optional().describe("Return base64 bytes instead of text."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        const file = resolveInside(args.path);
        const stat = await fsp.stat(file).catch(() => undefined);
        if (!stat) return fail(`File not found: ${toRelative(file)}`);
        if (stat.isDirectory()) return fail(`${toRelative(file)} is a directory. Use list_directory.`);

        const buffer = await fsp.readFile(file);
        if (args.as_base64 || looksBinary(buffer)) {
          if (!args.as_base64) {
            return ok(
              `BINARY FILE (${humanBytes(stat.size)}) — ${toRelative(file)}\n` +
                `Showing base64 (${buffer.length} bytes):\n\n${buffer.toString("base64")}`,
            );
          }
          return ok(buffer.toString("base64"));
        }

        const text = buffer.toString("utf8");
        const allLines = text.split("\n");
        const start = (args.offset ?? 1) - 1;
        const max = args.limit ?? allLines.length;
        const slice = allLines.slice(start, start + max);

        const body = args.line_numbers
          ? slice.map((line, i) => `${String(start + i + 1).padStart(5)}: ${line}`).join("\n")
          : slice.join("\n");

        const header =
          `FILE ${toRelative(file)} — ${allLines.length} lines, ${humanBytes(stat.size)}` +
          (args.offset || args.limit
            ? ` — showing lines ${start + 1}-${Math.min(start + max, allLines.length)}`
            : "");

        return ok(`${header}\n${"—".repeat(Math.min(60, header.length))}\n${body}`);
      }),
  );

  server.registerTool(
    "write_file",
    {
      title: "Write file",
      description:
        "Create or overwrite a file with exact content. Parent directories are created automatically. " +
        "Use edit_file for surgical changes to an existing file.",
      inputSchema: {
        path: pathArg,
        content: z.string().describe("Full file content."),
        overwrite: z.boolean().optional().describe("Allow replacing an existing file. Default true."),
        executable: z.boolean().optional().describe("chmod +x after writing."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) =>
      guard(async () => {
        const file = resolveInside(args.path);
        const exists = fs.existsSync(file);
        if (exists && args.overwrite === false) return fail(`Refusing to overwrite ${toRelative(file)}.`);

        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(file, args.content, "utf8");
        if (args.executable) await fsp.chmod(file, 0o755);

        return ok(`${exists ? "Overwrote" : "Created"} ${toRelative(file)} (${humanBytes(Buffer.byteLength(args.content))}).`);
      }),
  );

  server.registerTool(
    "append_file",
    {
      title: "Append to file",
      description: "Append text to the end of a file, creating it if necessary.",
      inputSchema: {
        path: pathArg,
        content: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) =>
      guard(async () => {
        const file = resolveInside(args.path);
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.appendFile(file, args.content, "utf8");
        return ok(`Appended ${humanBytes(Buffer.byteLength(args.content))} to ${toRelative(file)}.`);
      }),
  );

  server.registerTool(
    "edit_file",
    {
      title: "Edit file (exact replace)",
      description:
        "Replace an exact string in a file. old_string must match verbatim, including indentation. " +
        "By default it must occur exactly once; set replace_all to change every occurrence. Include surrounding " +
        "context in old_string to target the right spot.",
      inputSchema: {
        path: pathArg,
        old_string: z.string().min(1).describe("Exact text to find."),
        new_string: z.string().describe("Replacement text."),
        replace_all: z.boolean().optional().describe("Replace every occurrence instead of requiring exactly one."),
        count: z.number().int().min(1).optional().describe("Require exactly this many occurrences before replacing."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) =>
      guard(async () => {
        const file = resolveInside(args.path);
        const before = await fsp.readFile(file, "utf8").catch(() => undefined);
        if (before === undefined) return fail(`File not found: ${toRelative(file)}`);

        const occurrences = before.split(args.old_string).length - 1;
        if (occurrences === 0) {
          return fail(
            `old_string was not found in ${toRelative(file)}. Read the file and copy the exact text (whitespace matters).`,
          );
        }
        const expected = args.count ?? (args.replace_all ? occurrences : 1);
        if (occurrences !== expected) {
          return fail(
            `old_string occurs ${occurrences} time(s) in ${toRelative(file)}, expected ${expected}. ` +
              `Add more context to make it unique, or pass replace_all=true.`,
          );
        }

        const after = args.replace_all
          ? before.split(args.old_string).join(args.new_string)
          : before.replace(args.old_string, args.new_string);

        await fsp.writeFile(file, after, "utf8");
        return ok(`Edited ${toRelative(file)} (${occurrences} replacement${occurrences === 1 ? "" : "s"}).`);
      }),
  );

  server.registerTool(
    "list_directory",
    {
      title: "List directory",
      description:
        "List files and folders, optionally recursive, with sizes. Common noise folders (node_modules, .git, dist) " +
        "are skipped unless you include them in the path.",
      inputSchema: {
        path: z.string().optional().describe("Directory to list. Defaults to the sandbox root."),
        depth: z.number().int().min(0).max(12).optional().describe("Recursion depth. Default 0 (this folder only)."),
        pattern: z.string().optional().describe('Glob filter on the relative path, e.g. "**/*.ts" or "*.json".'),
        include_hidden: z.boolean().optional().describe("Include dotfiles. Default true."),
        show_sizes: z.boolean().optional().describe("Include file sizes. Default true."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        const dir = resolveDir(args.path ?? ".");
        const depth = args.depth ?? 0;
        const entries = walk(dir, { maxDepth: depth, includeHidden: args.include_hidden ?? true });

        let filtered = entries;
        if (args.pattern) {
          const { globToRegExp } = await import("../lib/fsutil.js");
          const regex = globToRegExp(args.pattern);
          filtered = entries.filter((e) => regex.test(path.relative(dir, e.absolute).split(path.sep).join("/")) || regex.test(e.name));
        }

        if (!filtered.length) return ok(`No entries in ${toRelative(dir)}${args.pattern ? ` matching ${args.pattern}` : ""}.`);

        const lines = filtered.slice(0, 2000).map((entry) => {
          const marker = entry.isDirectory ? "/" : entry.isSymlink ? "@" : "";
          const size = args.show_sizes !== false && !entry.isDirectory ? `  ${humanBytes(entry.size).padStart(8)}` : "";
          return `${entry.relative}${marker}${size}`;
        });

        return ok(
          `${toRelative(dir)} — ${filtered.length} entries${filtered.length > 2000 ? " (showing first 2000)" : ""}\n` +
            lines.join("\n"),
        );
      }),
  );

  server.registerTool(
    "tree",
    {
      title: "Directory tree",
      description: "Render an indented ASCII tree of a directory. Handy for getting a quick structural overview.",
      inputSchema: {
        path: z.string().optional().describe("Root of the tree. Default sandbox root."),
        depth: z.number().int().min(1).max(8).optional().describe("Maximum depth. Default 3."),
        include_hidden: z.boolean().optional(),
        skip: z.array(z.string()).optional().describe("Extra directory names to skip."),
        max_entries: z.number().int().min(10).max(5000).optional().describe("Default 500."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        const root = resolveDir(args.path ?? ".");
        const maxDepth = args.depth ?? 3;
        const skip = new Set([...DEFAULT_SKIP_DIRS, ...(args.skip ?? [])]);
        const maxEntries = args.max_entries ?? 500;
        const lines: string[] = [path.basename(root) + "/"];
        let count = 0;

        const visit = (dir: string, prefix: string, depth: number): void => {
          if (depth > maxDepth || count >= maxEntries) return;
          let entries: fs.Dirent[];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          const visible = entries
            .filter((e) => (args.include_hidden ?? true) || !e.name.startsWith("."))
            .filter((e) => !(e.isDirectory() && skip.has(e.name)))
            .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

          visible.forEach((entry, index) => {
            if (count >= maxEntries) return;
            count++;
            const last = index === visible.length - 1;
            lines.push(`${prefix}${last ? "└── " : "├── "}${entry.name}${entry.isDirectory() ? "/" : ""}`);
            if (entry.isDirectory()) visit(path.join(dir, entry.name), `${prefix}${last ? "    " : "│   "}`, depth + 1);
          });
        };

        visit(root, "", 1);
        if (count >= maxEntries) lines.push(`… truncated at ${maxEntries} entries`);
        return ok(lines.join("\n"));
      }),
  );

  server.registerTool(
    "file_info",
    {
      title: "File information",
      description: "Stat a path: type, size, permissions, timestamps, line count and SHA-256 hash.",
      inputSchema: { path: pathArg },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        const file = resolveInside(args.path);
        const stat = await fsp.stat(file).catch(() => undefined);
        if (!stat) return fail(`Path not found: ${toRelative(file)}`);

        const lines: string[] = [
          `path:     ${toRelative(file)}`,
          `type:     ${stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file"}`,
          `size:     ${humanBytes(stat.size)} (${stat.size.toLocaleString()} bytes)`,
          `mode:     ${(stat.mode & 0o777).toString(8)}`,
          `modified: ${stat.mtime.toISOString()}`,
          `created:  ${stat.birthtime.toISOString()}`,
        ];

        if (stat.isFile() && stat.size < 200 * 1024 * 1024) {
          lines.push(`sha256:   ${await sha256(file)}`);
          if (stat.size < 5 * 1024 * 1024) {
            const buffer = await fsp.readFile(file);
            if (!looksBinary(buffer)) lines.push(`lines:    ${buffer.toString("utf8").split("\n").length}`);
          }
        }

        return ok(lines.join("\n"));
      }),
  );

  server.registerTool(
    "make_directory",
    {
      title: "Create directory",
      description: "Create a directory (and any missing parents) inside the sandbox.",
      inputSchema: { path: pathArg },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) =>
      guard(async () => {
        const dir = resolveInside(args.path);
        await fsp.mkdir(dir, { recursive: true });
        return ok(`Created ${toRelative(dir)}.`);
      }),
  );

  server.registerTool(
    "delete_path",
    {
      title: "Delete file or directory",
      description:
        "Delete a file or directory. Directories require recursive=true. This is permanent — there is no trash. " +
        "The sandbox root itself cannot be deleted.",
      inputSchema: {
        path: pathArg,
        recursive: z.boolean().optional().describe("Required to delete a non-empty directory."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) =>
      guard(async () => {
        const target = resolveInside(args.path);
        const root = resolveInside(".");
        if (target === root) return fail("Refusing to delete the sandbox root.");

        const stat = await fsp.lstat(target).catch(() => undefined);
        if (!stat) return fail(`Path not found: ${toRelative(target)}`);

        if (stat.isDirectory()) {
          const entries = await fsp.readdir(target);
          if (entries.length > 0 && !args.recursive) {
            return fail(`${toRelative(target)} is not empty. Pass recursive=true to delete it and its contents.`);
          }
          await fsp.rm(target, { recursive: true, force: true });
        } else {
          await fsp.unlink(target);
        }

        return ok(`Deleted ${toRelative(target)}.`);
      }),
  );

  server.registerTool(
    "move_path",
    {
      title: "Move / rename",
      description: "Move or rename a file or directory inside the sandbox. Creates the destination's parent folder.",
      inputSchema: {
        from: pathArg,
        to: pathArg,
        overwrite: z.boolean().optional().describe("Replace an existing destination. Default false."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) =>
      guard(async () => {
        const from = resolveInside(args.from);
        const to = resolveInside(args.to);
        if (!fs.existsSync(from)) return fail(`Source not found: ${toRelative(from)}`);
        if (fs.existsSync(to) && !args.overwrite) return fail(`Destination exists: ${toRelative(to)}`);
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.rename(from, to);
        return ok(`Moved ${toRelative(from)} → ${toRelative(to)}.`);
      }),
  );

  server.registerTool(
    "copy_path",
    {
      title: "Copy file or directory",
      description: "Copy a file or directory (recursively) to a new location inside the sandbox.",
      inputSchema: {
        from: pathArg,
        to: pathArg,
        overwrite: z.boolean().optional().describe("Replace an existing destination. Default false."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) =>
      guard(async () => {
        const from = resolveInside(args.from);
        const to = resolveInside(args.to);
        if (!fs.existsSync(from)) return fail(`Source not found: ${toRelative(from)}`);
        if (fs.existsSync(to) && !args.overwrite) return fail(`Destination exists: ${toRelative(to)}`);
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.cp(from, to, { recursive: true, force: !!args.overwrite, errorOnExist: !args.overwrite });
        return ok(`Copied ${toRelative(from)} → ${toRelative(to)}.`);
      }),
  );

  server.registerTool(
    "read_many_files",
    {
      title: "Read multiple files",
      description:
        "Read several files in one call. Useful for loading context quickly. Each file is capped; missing files are reported inline.",
      inputSchema: {
        paths: z.array(z.string()).min(1).max(50).describe("Files to read."),
        max_chars_each: z.number().int().min(200).max(200_000).optional().describe("Per-file cap. Default 20000."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        const cap = args.max_chars_each ?? 20_000;
        const blocks: string[] = [];
        for (const p of args.paths) {
          const file = resolveInside(p);
          const text = await fsp.readFile(file, "utf8").catch(() => undefined);
          if (text === undefined) {
            blocks.push(`===== ${p} =====\n(file not found or not text)`);
            continue;
          }
          const clipped = text.length > cap ? text.slice(0, cap) + `\n… [${text.length - cap} chars cut]` : text;
          blocks.push(`===== ${p} =====\n${clipped}`);
        }
        return ok(blocks.join("\n\n"));
      }),
  );
}

export const fileToolNames = [
  "read_file",
  "write_file",
  "append_file",
  "edit_file",
  "list_directory",
  "tree",
  "file_info",
  "make_directory",
  "delete_path",
  "move_path",
  "copy_path",
  "read_many_files",
];
