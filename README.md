# terminal-mcp

A sandboxed terminal, filesystem, git, network and system MCP server for **Claude** and **ChatGPT**.

67 tools, one workspace root, two transports (`stdio` and streamable HTTP), plus an optional Cloudflare
Worker relay so ChatGPT can reach your Mac without a tunnel process. Every file path and every shell
command is confined to a workspace folder — the model gets a real terminal without getting your whole Mac.

```
┌──────────────┐   MCP    ┌────────────────┐   sandbox-exec    ┌─────────────────────┐
│ Claude / GPT │ ───────► │  terminal-mcp  │ ────────────────► │  ./workspace/       │
└──────────────┘ stdio/http└────────────────┘  (kernel profile) └─────────────────────┘
```

---

## Quick start

```bash
cd terminal-mcp
npm install
npm run build
npm link          # puts `terminal-mcp` on your PATH

terminal-mcp      # start everything: sandboxed server + Cloudflare relay
```

Now from any directory:

```bash
terminal-mcp                 # server + relay, Ctrl+C stops both
terminal-mcp http --port 9000
terminal-mcp stdio           # for Claude Desktop / Code / Cursor
terminal-mcp relay --url https://relay.example.workers.dev
```

Verify the sandbox works end-to-end:

```bash
npm run smoke               # 26 checks
SMOKE_NPM=1 npm run smoke   # also proves npm install works inside the sandbox
```

Everything the server creates stays inside this folder:

```
terminal-mcp/
├── src/  dist/  worker/  bin/  scripts/      code
├── workspace/                               sandbox root — the only place commands can touch
└── state/                                   audit.log, relay-token (gitignored, never committed)
```

Both `workspace/` and `state/` are created on first run and are gitignored. Move them with
`TERMINAL_MCP_HOME` (both), `--root` / `TERMINAL_MCP_ROOT` (workspace only) or `TERMINAL_MCP_STATE`.

---

## Connecting clients

### Claude Code

```bash
claude mcp add terminal-mcp -- node "$(pwd)/dist/index.js" --root "$(pwd)/workspace"
claude mcp list
```

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "terminal": {
      "command": "node",
      "args": [
        "/Users/you/terminal-mcp/dist/index.js",
        "--root",
        "/Users/you/terminal-mcp/workspace"
      ]
    }
  }
}
```

Restart Claude Desktop. The 67 tools appear under the tools menu.

### Cursor / other stdio clients

`~/.cursor/mcp.json` uses the same `mcpServers` shape as above.

### ChatGPT (custom connector)

ChatGPT needs a public HTTPS URL. There are two ways to give it one — a permanent Worker relay (no domain,
no tunnel process) or a quick tunnel for testing.

#### Option A — Cloudflare Worker relay (recommended, permanent)

A Worker holds one outbound WebSocket to your Mac and forwards each MCP request down it. No inbound ports,
no `cloudflared`, no domain. URL stays the same across restarts.

```
ChatGPT ──https──► Worker (/mcp) ◄──wss── relay-agent (Mac) ──► 127.0.0.1:8787
```

Deploy once:

```bash
cd worker
npm install
npx wrangler login                 # opens the browser
npx wrangler secret put RELAY_TOKEN  # paste a long random secret
npx wrangler deploy
```

Wrangler prints `https://terminal-mcp.<your-subdomain>.workers.dev`. Start both halves with one command:

```bash
terminal-mcp
```

That boots the local MCP server on `:8787` in JSON mode, waits for it to be healthy, connects the relay agent,
and stops both on Ctrl+C. Override anything with the environment:

```bash
RELAY_URL=https://other.workers.dev PORT=9000 TERMINAL_MCP_ROOT=~/scratch terminal-mcp
```

Equivalent to doing it by hand in two terminals:

```bash
npm run serve:json
npm run relay -- --url https://terminal-mcp.<subdomain>.workers.dev --token "$(cat ./state/relay-token)"
```

Check it: `curl https://<worker>/health` → `{"online":true,...}`, and open `https://<worker>/` for a status page.

In ChatGPT: **Settings → Connectors → Advanced → Developer mode → Add custom connector**

| Field | Value |
|---|---|
| Name | `terminal` |
| URL | `https://terminal-mcp.<subdomain>.workers.dev/mcp?token=<secret>` |
| Authentication | None (token is in the URL) |

If the connector drops sessions, add `--stateless` to the local server.

#### Option B — Quick tunnel (temporary)

```bash
node dist/index.js --http --port 8787 --token super-secret-token
cloudflared tunnel --url http://127.0.0.1:8787   # random trycloudflare.com URL, dies with the process
```

Use the printed `https://<random>.trycloudflare.com/mcp?token=super-secret-token` as the connector URL.
For a stable hostname, create a **named** tunnel instead (`cloudflared tunnel create` + DNS route + service).

> The URL is a credential. Anyone with it can run commands in the workspace.

---

## The sandbox

Two independent layers, both on by default.

**1. Path jail (always on).** Every path argument is resolved against the workspace root, symlinks are
resolved to their real target, and anything landing outside the root is rejected:

```
Path escapes the sandbox: ../../etc/passwd
Sandbox root: /Users/you/terminal-mcp/workspace
Resolved to:  /Users/etc/passwd
```

**2. Kernel sandbox (`strict` mode).** Commands are executed through `sandbox-exec` on macOS (or `bwrap`
on Linux) with a generated profile:

| | allowed |
|---|---|
| **write** | workspace root, `.tmp/`, OS temp dir, `/dev/null`, `/dev/stdout`, `/dev/stderr` |
| **read** | system paths, toolchains, workspace — **except** `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker/config.json`, `~/.config/gh`, `~/.netrc`, `~/.npmrc`, `~/.pypirc` |
| **network** | allowed unless you pass `--no-network` |
| **process** | fork/exec allowed (needed for compilers, npm, git) |

Verified behaviours from the smoke test:

```
PASS  kernel sandbox blocks writes outside workspace
PASS  kernel sandbox blocks reading ~/.ssh
PASS  npm install works inside sandbox
```

Environment inside the sandbox is redirected so tools stay contained: `TMPDIR`, `XDG_CACHE_HOME` and
`npm_config_cache` point into the workspace.

### Modes

| mode | path jail | kernel sandbox | use when |
|---|---|---|---|
| `strict` *(default)* | ✅ | ✅ | normal use — untrusted or exploratory work |
| `workspace` | ✅ | ❌ | the toolchain fights the kernel profile (Docker, some IDEs) |
| `off` | ❌ | ❌ | throwaway VM only |

```bash
node dist/index.js --root ./workspace --sandbox workspace
```

`sandbox_selftest` actively probes the confinement and reports pass/fail at runtime.

---

## Tools (67)

### Shell — 9
| tool | purpose |
|---|---|
| `run_command` | run a shell command (cwd, timeout, env, stdin, background) |
| `run_script` | run inline bash / python / node source |
| `start_process` | background long-running process, returns an id |
| `read_process` | incremental stdout/stderr by offset |
| `write_process` | send stdin (answer prompts, REPLs) |
| `wait_process` | block until exit |
| `kill_process` | signal a managed process or raw pid |
| `list_processes` | managed processes + optional `ps` snapshot |
| `kill_all_processes` | clean shutdown of everything it started |

### Files — 12
`read_file` `write_file` `append_file` `edit_file` `list_directory` `tree` `file_info`
`make_directory` `delete_path` `move_path` `copy_path` `read_many_files`

`edit_file` is an exact-string replace that refuses ambiguous matches, so the model has to read before it writes.

### Search — 4
`find_files` (globs with `**`, `?`, `{a,b}`) `search_text` (regex, context lines) `replace_text`
(bulk regex replace, dry-run by default) `count_lines`

### Git — 14
`git_status` `git_diff` `git_log` `git_show` `git_blame` `git_branches` `git_checkout` `git_commit`
`git_clone` `git_push` `git_pull` `git_stash` `git_remotes` `git_init`

### Network — 6
`http_request` `download_file` `check_port` `dns_lookup` `ping` `public_ip`

### System — 11
`system_info` `disk_usage` `env_vars` (secrets masked) `clipboard_read` `clipboard_write` `screenshot`
`notify` `open_url` `listening_ports` `which_command` `current_time`

### Data — 6
`diff_files` `hash` `base64` `archive` (zip / tar / tar.gz) `json_query` `json_set`

### Meta — 5
`sandbox_info` `sandbox_selftest` `command_history` `clear_history` `list_capabilities`

`command_history` reads an append-only JSONL audit log at `./state/audit.log` — deliberately
**outside** the workspace so the agent cannot erase its own tracks.

---

## CLI reference

```
terminal-mcp [--stdio] [--http] [options]

  --root <dir>        workspace to confine the agent to   (default ./workspace)
  --sandbox <mode>    strict | workspace | off            (default strict)
  --no-network        deny network to sandboxed commands
  --timeout <ms>      default command timeout             (default 120000)

  --host <addr>       HTTP bind address                   (default 127.0.0.1)
  --port <port>       HTTP port                           (default 8787)
  --token <secret>    require Bearer auth
  --stateless         no session tracking (hosted connectors)
  --json-response     answer with JSON instead of SSE (needed behind the CF relay)

  --help, --version
```

Environment equivalents: `TERMINAL_MCP_ROOT`, `TERMINAL_MCP_SANDBOX`, `TERMINAL_MCP_NETWORK=0`,
`TERMINAL_MCP_TIMEOUT_MS`, `TERMINAL_MCP_MAX_OUTPUT`, `TERMINAL_MCP_HOST`, `TERMINAL_MCP_PORT`,
`TERMINAL_MCP_TOKEN`, `TERMINAL_MCP_READ_PATHS`, `TERMINAL_MCP_WRITE_PATHS`.

Endpoints: `POST/GET/DELETE /mcp` (MCP), `GET /health`.

The server refuses to bind a non-loopback address without a token unless
`TERMINAL_MCP_ALLOW_INSECURE=1` is set.

---

## Safety model

This is a real shell. The sandbox bounds *where* it can act, not *what* it can do inside that bound.
Inside the workspace the model can create, modify and delete anything, install packages and reach the network.

What it cannot do (in `strict` mode): write outside the workspace, read your SSH/AWS/GPG/gh credentials, or
persist changes anywhere else on disk. The host-integration tools (`screenshot`, `notify`, `clipboard_*`,
`open_url`, `listening_ports`) run outside the sandbox by design, but each executes a fixed binary with
validated arguments and no user-controlled shell string.

Recommended posture: keep `strict`, keep the workspace a folder you don't mind losing, and review
`command_history` after a long session.

**Exposing it to ChatGPT.** The Worker relay authenticates with a shared `RELAY_TOKEN` and only forwards
`/mcp`; the local server should stay bound to `127.0.0.1` so the agent is the only client. Treat the
connector URL (`…/mcp?token=…`) as the password it is: rotate the secret with
`wrangler secret put RELAY_TOKEN` and restart the agent. If you want a second layer, put Cloudflare Access
in front of the Worker and add a service token bypass for the `/mcp` path.

---

## Layout

```
src/
  index.ts            CLI entry, stdio + HTTP transports
  server.ts           McpServer factory, tool registration
  config.ts           flags / env / defaults
  relay-agent.ts      Mac-side outbound agent for the Cloudflare Worker relay
bin/terminal-mcp      global launcher (`terminal-mcp`, `stdio`, `http`, `relay`)
  lib/
    sandbox.ts        path jail + workspace-relative resolution
    osSandbox.ts      sandbox-exec / bwrap profile generation
    exec.ts           spawn with timeout, output capping, tree kill
    processes.ts      managed background process registry
    fsutil.ts         confined walker, glob→regex
    audit.ts          JSONL audit log
  tools/
    shell.ts files.ts search.ts git.ts net.ts system.ts data.ts meta.ts
  relay-agent.ts      Mac-side outbound agent for the Cloudflare Worker relay
scripts/smoke.ts      end-to-end test over stdio
worker/
  src/index.ts        Worker entry: auth, landing page, routing
  src/relay.ts        Durable Object holding the WebSocket to the Mac
  src/protocol.ts     wire protocol between Worker and agent
```

## Troubleshooting

| symptom | fix |
|---|---|
| `OS sandbox unavailable` on macOS | `sandbox-exec` was removed on your build — the server falls back to path-jail only; rebuild with `--sandbox workspace` to silence the warning |
| `npm install` fails with EPERM | run with `--sandbox workspace`, or add the path via `TERMINAL_MCP_WRITE_PATHS` |
| Docker / kubectl fail | they need the host socket and full writes — use `workspace` mode for those sessions |
| ChatGPT connector errors on session | add `--stateless` |
| Server won't start on `0.0.0.0` | pass `--token`, or set `TERMINAL_MCP_ALLOW_INSECURE=1` |
