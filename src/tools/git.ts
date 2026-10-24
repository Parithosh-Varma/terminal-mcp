import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logAudit } from "../lib/audit.js";
import { runCommand, type ExecResult } from "../lib/exec.js";
import { fail, guard, ok } from "../lib/format.js";
import { resolveDir, toRelative } from "../lib/sandbox.js";
import { which } from "../lib/which.js";

const repoArg = z
  .string()
  .optional()
  .describe("Repository directory relative to the sandbox root. Defaults to the sandbox root.");

function summarise(result: ExecResult, title?: string): string {
  const body = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  const header = title ? `${title}\n` : "";
  if (result.exitCode !== 0) {
    return `${header}[git exited ${result.exitCode}]\n${body || "(no output)"}`;
  }
  return header + (body || "(no output)");
}

async function git(args: string[], cwd?: string, timeoutMs = 60_000): Promise<ExecResult> {
  const dir = resolveDir(cwd ?? ".");
  // Git has no global --no-color option; passing it per subcommand breaks the
  // ones that don't define it (git clone rejects it outright). Disable colour
  // through config instead, which every command honours.
  const clean = args.filter((arg) => arg !== "--no-color");
  return runCommand("git", ["-c", "color.ui=false", ...clean], { cwd: dir, timeoutMs });
}

export function registerGitTools(server: McpServer): void {
  server.registerTool(
    "git_status",
    {
      title: "Git status",
      description: "Show the working tree status (branch, staged, unstaged and untracked changes) in porcelain plus human format.",
      inputSchema: {
        repo: repoArg,
        short: z.boolean().optional().describe("Use short/porcelain output only."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        if (!which("git")) return fail("git is not installed or not on PATH.");
        const dir = args.repo ?? ".";
        const first = await git(["status", "--porcelain=v1", "--branch"], dir);
        if (first.exitCode !== 0) return fail(summarise(first));

        if (args.short) return ok(first.stdout.trim() || "(clean)");

        const second = await git(["status"], dir);
        return ok(`repo: ${toRelative(resolveDir(dir))}\n\n${second.stdout.trim()}\n\n--- porcelain ---\n${first.stdout.trim()}`);
      }),
  );

  server.registerTool(
    "git_diff",
    {
      title: "Git diff",
      description: "Show changes. Defaults to unstaged diff; set staged=true for the index or pass a ref to diff against it.",
      inputSchema: {
        repo: repoArg,
        path: z.string().optional().describe("Limit the diff to this path."),
        staged: z.boolean().optional().describe("Diff the index instead of the working tree."),
        ref: z.string().optional().describe("Diff against a commit/branch, e.g. HEAD~3 or main."),
        stat_only: z.boolean().optional().describe("Only show the summary stat."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        const argv = ["diff", "--no-color"];
        if (args.staged) argv.push("--staged");
        if (args.stat_only) argv.push("--stat");
        if (args.ref) argv.push(args.ref);
        if (args.path) argv.push("--", args.path);
        const result = await git(argv, args.repo);
        return ok(result.stdout.trim() ? result.stdout.trim() : summarise(result, "(no changes)"));
      }),
  );

  server.registerTool(
    "git_log",
    {
      title: "Git log",
      description: "Show recent commits, one line each by default.",
      inputSchema: {
        repo: repoArg,
        limit: z.number().int().min(1).max(200).optional().describe("Number of commits. Default 20."),
        author: z.string().optional(),
        path: z.string().optional().describe("Only commits touching this path."),
        full: z.boolean().optional().describe("Include full commit messages and stats."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        const argv = ["log", "--no-color", `-n`, String(args.limit ?? 20)];
        if (!args.full) argv.push("--oneline", "--decorate");
        if (args.author) argv.push(`--author=${args.author}`);
        if (args.path) argv.push("--", args.path);
        const result = await git(argv, args.repo);
        return ok(summarise(result));
      }),
  );

  server.registerTool(
    "git_show",
    {
      title: "Git show",
      description: "Show a commit, tag or object (message, author, diff).",
      inputSchema: {
        repo: repoArg,
        ref: z.string().optional().describe("Commit hash, branch or tag. Default HEAD."),
        stat_only: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        const argv = ["show", "--no-color"];
        if (args.stat_only) argv.push("--stat");
        argv.push(args.ref ?? "HEAD");
        return ok(summarise(await git(argv, args.repo)));
      }),
  );

  server.registerTool(
    "git_blame",
    {
      title: "Git blame",
      description: "Show last-modified commit per line for a file.",
      inputSchema: {
        repo: repoArg,
        file: z.string().describe("File path relative to the repository root."),
        start: z.number().int().min(1).optional().describe("First line."),
        end: z.number().int().min(1).optional().describe("Last line."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        const argv = ["blame", "--date=short"];
        if (args.start && args.end) argv.push(`-L`, `${args.start},${args.end}`);
        argv.push(args.file);
        return ok(summarise(await git(argv, args.repo)));
      }),
  );

  server.registerTool(
    "git_branches",
    {
      title: "List branches",
      description: "List local (and optionally remote) branches with current branch highlighted and last commit.",
      inputSchema: {
        repo: repoArg,
        all: z.boolean().optional().describe("Include remote branches."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        const result = await git(["branch", "-vv", ...(args.all ? ["-a"] : [])], args.repo);
        const current = await git(["rev-parse", "--abbrev-ref", "HEAD"], args.repo);
        return ok(`current: ${current.stdout.trim() || "?"}\n\n${summarise(result)}`);
      }),
  );

  server.registerTool(
    "git_checkout",
    {
      title: "Switch branch / restore files",
      description:
        "Check out a branch, tag or commit. Set create=true to create a new branch (optionally from a start point). " +
        "Pass paths to restore specific files instead.",
      inputSchema: {
        repo: repoArg,
        target: z.string().describe("Branch, tag, commit, or `--` followed by paths."),
        create: z.boolean().optional().describe("Create the branch if it does not exist."),
        start_point: z.string().optional().describe("Base ref when creating a branch."),
        paths: z.array(z.string()).optional().describe("Restore only these paths."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) =>
      guard(async () => {
        const argv = ["checkout", "--no-color"];
        if (args.create) argv.push("-b");
        argv.push(args.target);
        if (args.start_point) argv.push(args.start_point);
        if (args.paths?.length) argv.push("--", ...args.paths);
        const result = await git(argv, args.repo);
        await logAudit({ ts: new Date().toISOString(), tool: "git_checkout", command: `git ${argv.join(" ")}` });
        return ok(summarise(result));
      }),
  );

  server.registerTool(
    "git_commit",
    {
      title: "Commit changes",
      description:
        "Create a commit. With stage_all=true it runs `git add -A` first; otherwise only already-staged changes are committed.",
      inputSchema: {
        repo: repoArg,
        message: z.string().min(1).describe("Commit message."),
        stage_all: z.boolean().optional().describe("Stage every change first. Default true."),
        amend: z.boolean().optional().describe("Amend the previous commit."),
        paths: z.array(z.string()).optional().describe("Stage only these paths before committing."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) =>
      guard(async () => {
        if (args.stage_all !== false) {
          const add = await git(args.paths?.length ? ["add", "--", ...args.paths] : ["add", "-A"], args.repo);
          if (add.exitCode !== 0) return fail(summarise(add, "git add failed"));
        }
        const argv = ["commit", "--no-color", "-m", args.message];
        if (args.amend) argv.push("--amend");
        const result = await git(argv, args.repo);
        await logAudit({ ts: new Date().toISOString(), tool: "git_commit", command: `git ${argv.join(" ")}` });
        return ok(summarise(result, result.exitCode === 0 ? "Committed." : "Commit failed."));
      }),
  );

  server.registerTool(
    "git_clone",
    {
      title: "Clone repository",
      description:
        "Clone a git repository into the sandbox. The URL may be https or ssh; credentials must already be configured.",
      inputSchema: {
        url: z.string().describe("Repository URL."),
        directory: z.string().optional().describe("Destination folder relative to the sandbox root."),
        depth: z.number().int().min(1).optional().describe("Shallow clone depth."),
        branch: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const argv = ["clone", "--no-color"];
        if (args.depth) argv.push("--depth", String(args.depth));
        if (args.branch) argv.push("--branch", args.branch);
        argv.push(args.url);
        if (args.directory) argv.push(args.directory);
        const result = await git(argv, ".", 600_000);
        await logAudit({ ts: new Date().toISOString(), tool: "git_clone", command: `git ${argv.join(" ")}` });
        return ok(summarise(result, result.exitCode === 0 ? "Cloned." : "Clone failed."));
      }),
  );

  server.registerTool(
    "git_push",
    {
      title: "Push",
      description: "Push commits to a remote. Use set_upstream=true the first time a branch is pushed.",
      inputSchema: {
        repo: repoArg,
        remote: z.string().optional().describe("Default origin."),
        branch: z.string().optional().describe("Default current branch."),
        set_upstream: z.boolean().optional(),
        force: z.boolean().optional().describe("Force-push with --force-with-lease."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const argv = ["push"];
        if (args.force) argv.push("--force-with-lease");
        argv.push(args.remote ?? "origin");
        if (args.branch) argv.push(args.branch);
        if (args.set_upstream) argv.push("-u");
        const result = await git(argv, args.repo, 180_000);
        await logAudit({ ts: new Date().toISOString(), tool: "git_push", command: `git ${argv.join(" ")}` });
        return ok(summarise(result));
      }),
  );

  server.registerTool(
    "git_pull",
    {
      title: "Pull",
      description: "Fetch and integrate changes from a remote.",
      inputSchema: {
        repo: repoArg,
        remote: z.string().optional().describe("Default origin."),
        branch: z.string().optional(),
        rebase: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const argv = ["pull"];
        if (args.rebase) argv.push("--rebase");
        argv.push(args.remote ?? "origin");
        if (args.branch) argv.push(args.branch);
        const result = await git(argv, args.repo, 180_000);
        return ok(summarise(result));
      }),
  );

  server.registerTool(
    "git_stash",
    {
      title: "Stash",
      description: "Stash or restore uncommitted changes. Actions: push, pop, apply, list, drop.",
      inputSchema: {
        repo: repoArg,
        action: z.enum(["push", "pop", "apply", "list", "drop"]).describe("Stash operation."),
        message: z.string().optional(),
        index: z.number().int().min(0).optional().describe("Stash entry index for pop/apply/drop."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) =>
      guard(async () => {
        const argv = ["stash", args.action];
        if (args.action === "push" && args.message) argv.push("-m", args.message);
        if (["pop", "apply", "drop"].includes(args.action) && args.index !== undefined) {
          argv.push(`stash@{${args.index}}`);
        }
        return ok(summarise(await git(argv, args.repo)));
      }),
  );

  server.registerTool(
    "git_remotes",
    {
      title: "List remotes",
      description: "Show configured remotes and their URLs.",
      inputSchema: { repo: repoArg },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => ok(summarise(await git(["remote", "-v"], args.repo)))),
  );

  server.registerTool(
    "git_init",
    {
      title: "Initialise repository",
      description: "Create a new git repository at the given path (git init).",
      inputSchema: {
        path: z.string().optional().describe("Directory to initialise. Default sandbox root."),
        branch: z.string().optional().describe('Initial branch name, e.g. "main".'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) =>
      guard(async () => {
        const dir = resolveDir(args.path ?? ".");
        const argv = ["init"];
        if (args.branch) argv.push("-b", args.branch);
        return ok(summarise(await runCommand("git", argv, { cwd: dir })));
      }),
  );
}

export const gitToolNames = [
  "git_status",
  "git_diff",
  "git_log",
  "git_show",
  "git_blame",
  "git_branches",
  "git_checkout",
  "git_commit",
  "git_clone",
  "git_push",
  "git_pull",
  "git_stash",
  "git_remotes",
  "git_init",
];
