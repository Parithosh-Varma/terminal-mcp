export interface Tool {
  name: string;
  desc: string;
}

export interface ToolGroup {
  id: string;
  label: string;
  icon: string;
  blurb: string;
  tools: Tool[];
}

export const groups: ToolGroup[] = [
  {
    id: "shell",
    label: "Shell",
    icon: "$_",
    blurb: "Real commands, background processes, REPLs — with timeouts, tree-kill and output caps.",
    tools: [
      { name: "run_command", desc: "run a shell command — cwd, timeout, env, stdin" },
      { name: "run_script", desc: "run inline bash / python / node source" },
      { name: "start_process", desc: "launch a background process, get an id" },
      { name: "read_process", desc: "read stdout / stderr incrementally by offset" },
      { name: "write_process", desc: "send stdin — answer prompts, drive REPLs" },
      { name: "wait_process", desc: "block until a process exits" },
      { name: "kill_process", desc: "signal a managed process or raw pid" },
      { name: "list_processes", desc: "managed processes plus an optional ps snapshot" },
      { name: "kill_all_processes", desc: "clean shutdown of everything it started" },
    ],
  },
  {
    id: "files",
    label: "Files",
    icon: "▤▦",
    blurb: "Every path resolved against the workspace root. Symlinks chased, escapes rejected.",
    tools: [
      { name: "read_file", desc: "read a file as text or base64" },
      { name: "write_file", desc: "write a file, parent dirs created" },
      { name: "append_file", desc: "append to a file" },
      { name: "edit_file", desc: "exact-string replace — refuses ambiguous matches" },
      { name: "list_directory", desc: "list a directory with types and sizes" },
      { name: "tree", desc: "recursive tree view with a depth limit" },
      { name: "file_info", desc: "stat, mime type and hash in one call" },
      { name: "make_directory", desc: "mkdir -p inside the workspace" },
      { name: "delete_path", desc: "remove a file or tree, workspace only" },
      { name: "move_path", desc: "move or rename" },
      { name: "copy_path", desc: "copy a file or a whole directory" },
      { name: "read_many_files", desc: "batch-read many paths in one call" },
    ],
  },
  {
    id: "search",
    label: "Search",
    icon: "//?",
    blurb: "Globs, regex, bulk replace with dry-run by default.",
    tools: [
      { name: "find_files", desc: "glob search with **, ? and {a,b}" },
      { name: "search_text", desc: "regex search with context lines" },
      { name: "replace_text", desc: "bulk regex replace, dry-run by default" },
      { name: "count_lines", desc: "line / word / char counts" },
    ],
  },
  {
    id: "git",
    label: "Git",
    icon: "⎇",
    blurb: "Full repo workflow without colour codes or pager hangs.",
    tools: [
      { name: "git_status", desc: "working tree status, machine-readable" },
      { name: "git_diff", desc: "working tree or commit diffs" },
      { name: "git_log", desc: "commit log with formatting" },
      { name: "git_show", desc: "inspect any object" },
      { name: "git_blame", desc: "who changed what, line by line" },
      { name: "git_branches", desc: "list local and remote branches" },
      { name: "git_checkout", desc: "switch or create branches" },
      { name: "git_commit", desc: "commit specific paths, message required" },
      { name: "git_clone", desc: "clone a repo into the sandbox" },
      { name: "git_push", desc: "push a branch or a tag" },
      { name: "git_pull", desc: "pull / fast-forward" },
      { name: "git_stash", desc: "stash push, pop, list" },
      { name: "git_remotes", desc: "list remotes and their URLs" },
      { name: "git_init", desc: "init a fresh repository" },
    ],
  },
  {
    id: "net",
    label: "Network",
    icon: "→→",
    blurb: "Dial out from inside the sandbox (or deny it entirely with --no-network).",
    tools: [
      { name: "http_request", desc: "GET / POST / … with headers and body" },
      { name: "download_file", desc: "download a URL into the workspace" },
      { name: "check_port", desc: "is a host:port reachable" },
      { name: "dns_lookup", desc: "resolve names to addresses" },
      { name: "ping", desc: "latency probe" },
      { name: "public_ip", desc: "this machine's public address" },
    ],
  },
  {
    id: "system",
    label: "System",
    icon: "⚙",
    blurb: "Machine introspection and desktop actions — secrets always masked.",
    tools: [
      { name: "system_info", desc: "os, cpu, memory, load, uptime" },
      { name: "disk_usage", desc: "disk usage for paths" },
      { name: "env_vars", desc: "environment with secrets masked" },
      { name: "clipboard_read", desc: "read the clipboard" },
      { name: "clipboard_write", desc: "write the clipboard" },
      { name: "screenshot", desc: "capture the screen to a file" },
      { name: "notify", desc: "post a desktop notification" },
      { name: "open_url", desc: "open a url or file in the default app" },
      { name: "listening_ports", desc: "sockets in LISTEN state" },
      { name: "which_command", desc: "locate a binary on PATH" },
      { name: "current_time", desc: "now, in the formats you want" },
    ],
  },
  {
    id: "data",
    label: "Data",
    icon: "{}",
    blurb: "Diff, hash and reshape data without leaving the protocol.",
    tools: [
      { name: "diff_files", desc: "unified diff of two files" },
      { name: "hash", desc: "sha256 (and friends) of data or a file" },
      { name: "base64", desc: "encode and decode" },
      { name: "archive", desc: "zip / tar / tar.gz — pack and unpack" },
      { name: "json_query", desc: "query JSON by path" },
      { name: "json_set", desc: "set a path in JSON and write it back" },
    ],
  },
  {
    id: "meta",
    label: "Meta",
    icon: "::",
    blurb: "The sandbox reports on itself. The audit log lives outside the jail on purpose.",
    tools: [
      { name: "sandbox_info", desc: "current root, mode, layer status" },
      { name: "sandbox_selftest", desc: "actively probe the confinement" },
      { name: "command_history", desc: "read the audit log back" },
      { name: "clear_history", desc: "reset the audit log" },
      { name: "list_capabilities", desc: "what this build can do" },
    ],
  },
];

export const totalTools = groups.reduce((n, g) => n + g.tools.length, 0);
