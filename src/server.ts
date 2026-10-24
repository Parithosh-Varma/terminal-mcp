import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "./config.js";
import { registerDataTools } from "./tools/data.js";
import { registerFileTools } from "./tools/files.js";
import { registerGitTools } from "./tools/git.js";
import { registerMetaTools } from "./tools/meta.js";
import { registerNetTools } from "./tools/net.js";
import { registerSearchTools } from "./tools/search.js";
import { registerShellTools } from "./tools/shell.js";
import { registerSystemTools } from "./tools/system.js";

export const SERVER_NAME = "terminal-mcp";
export const SERVER_VERSION = "0.1.0";

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: [
        `You have access to a real terminal and filesystem, confined to the workspace at ${config.root}.`,
        `Enforcement mode: ${config.mode}. Every file path is relative to that workspace root; absolute paths outside it are rejected.`,
        ``,
        `Typical workflow:`,
        `1. list_directory or tree to orient yourself.`,
        `2. read_file before editing; edit_file needs an exact, unique old_string.`,
        `3. run_command for builds, tests, package managers and CLIs.`,
        `4. start_process + read_process for long-running servers; kill_process when done.`,
        ``,
        `Notes:`,
        `- Outputs are truncated in the middle when large; use offsets/limits or head/tail.`,
        `- Prefer search_text/find_files over shelling out to grep/find.`,
        `- Every command is audited; command_history shows what has run.`,
      ].join("\n"),
    },
  );

  registerShellTools(server);
  registerFileTools(server);
  registerSearchTools(server);
  registerGitTools(server);
  registerNetTools(server);
  registerSystemTools(server);
  registerDataTools(server);
  registerMetaTools(server);

  return server;
}

export const TOOL_COUNT = 0; // replaced at build time by the CLI banner helper below
export function toolCount(): number {
  return (
    [
      "run_command",
      "run_script",
      "start_process",
      "read_process",
      "write_process",
      "kill_process",
      "wait_process",
      "list_processes",
      "kill_all_processes",
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
      "find_files",
      "search_text",
      "replace_text",
      "count_lines",
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
      "http_request",
      "download_file",
      "check_port",
      "dns_lookup",
      "ping",
      "public_ip",
      "system_info",
      "disk_usage",
      "env_vars",
      "clipboard_read",
      "clipboard_write",
      "screenshot",
      "notify",
      "open_url",
      "listening_ports",
      "which_command",
      "current_time",
      "diff_files",
      "hash",
      "base64",
      "archive",
      "json_query",
      "json_set",
      "sandbox_info",
      "sandbox_selftest",
      "command_history",
      "clear_history",
      "list_capabilities",
    ].length
  );
}
