# terminal-mcp

A sandboxed terminal, filesystem, git, network and system MCP server for **Claude** and **ChatGPT**.

67 tools, one workspace root, two transports (`stdio` and streamable HTTP), plus an optional Cloudflare
Worker relay so ChatGPT can reach your Mac without a tunnel process. Every file path and every shell
command is confined to a workspace folder — the model gets a real terminal without getting your whole Mac.

Live status page: **https://terminal-mcp.pages.dev**

```
┌──────────────┐   MCP    ┌────────────────┐   sandbox-exec    ┌─────────────────────┐
│ Claude / GPT │ ───────► │  terminal-mcp  │ ────────────────► │  sand1, sand2, …    │
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
├── sand1/  sand2/  sand3/  …                 one sandbox per session
├── workspace/                               only used with --shared
└── state/                                   audit.log, relay-url, relay-token, sessions.jsonl (gitignored)
```

All of these are created on first run and are gitignored. Move them with `TERMINAL_MCP_HOME`
(everything), `--root` / `TERMINAL_MCP_ROOT` (pin a single shared workspace) or `TERMINAL_MCP_STATE`.

---

## One sandbox per session

Every time a client opens a new MCP session — a new chat, a new app launch, a reconnect — the server
creates the next free directory next to the code. Nothing is created just for connecting — a health
check or `tools/list` leaves no folder behind, so `sandN` really means "this session did real work":

```
sand1/   ← first session
sand2/   ← second session
sand3/   ← third session
```

A session cannot see, read or write another session's files; the path jail treats `../sand2` as an
escape and refuses it. Each `sandN` is a full independent workspace, so parallel chats never fight over
the same files or the same git repo.

```bash
ls -d sand*                 # see every session's folder
rm -rf sand3                # delete one you are done with
terminal-mcp --shared       # opt out: one shared ./workspace for everything
terminal-mcp --root ~/code  # pin any folder instead
```

`state/sessions.jsonl` records which `sandN` belonged to which MCP session id and when it was created,
and `sandbox_info` reports the current session's folder plus the full list.

---

## Connecting clients

### Claude Code

```bash
claude mcp add terminal-mcp -- node "$(pwd)/dist/index.js"
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
        "/Users/you/terminal-mcp/dist/index.js"
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

Wrangler prints `https://terminal-mcp.<your-subdomain>.workers.dev`. Save it once, then start both halves:

```bash
echo "https://terminal-mcp.<your-subdomain>.workers.dev" > state/relay-url
echo "<the same secret you gave wrangler>" > state/relay-token && chmod 600 state/relay-token
terminal-mcp
```

Nothing relay-specific is hardcoded in the repo: `terminal-mcp` reads `state/relay-url` (or `RELAY_URL`)
and `state/relay-token` (or `RELAY_TOKEN`). With no URL configured it runs the local server only.
Override anything with the environment:

```bash
RELAY_URL=https://other.workers.dev PORT=9000 TERMINAL_MCP_ROOT=~/scratch terminal-mcp
```

Equivalent to doing it by hand in two terminals:

```bash
npm run serve:json
RELAY_TOKEN="$(cat ./state/relay-token)" npm run relay -- --url "$(cat ./state/relay-url)"
```

Check it: `curl https://<worker>/health` → `{"online":true,...}`, and open `https://<worker>/` for a status page.

Run one instance per machine. A second `terminal-mcp` detects the running supervisor and exits with
`terminal-mcp is already running (pid …)` — two agents would otherwise keep replacing each other's
upstream socket and every request would hang. The agent also pings every 25 s; the Worker routes to the
newest socket that has spoken within 90 s, so a dead connection can never swallow a request.

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

Three independent layers, all on by default.

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

**3. Environment scrubbing (always on).** Anything that looks like a credential is dropped before the
child process starts, so `env`, `printenv` and friends cannot see it:

```
CLOUDFLARE_API_TOKEN, AWS_*, OPENAI_*, ANTHROPIC_*, GITHUB_TOKEN, GH_*, NPM_TOKEN,
SSH_AUTH_SOCK, anything matching *_TOKEN, *_KEY, *_SECRET, *_PASSWORD, *AUTH*, *COOKIE*
```

This closes the gap the kernel profile leaves open: it protects credential *files*, not credentials you
exported in your shell. If a tool genuinely needs one, allow it by name:

```bash
TERMINAL_MCP_PASS_ENV=SSH_AUTH_SOCK,NPM_TOKEN terminal-mcp
```

Combine with `--no-network` when the model is working on untrusted input, and note that the relay token
is passed to the agent through the environment (never argv), so it does not appear in `ps`.

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

  --root <dir>        pin one shared workspace            (default: sand1, sand2, … per session)
  --shared            one shared ./workspace instead of per-session sandboxes
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

Environment equivalents: `TERMINAL_MCP_HOME`, `TERMINAL_MCP_STATE`, `TERMINAL_MCP_ROOT`, `TERMINAL_MCP_SHARED=1`,
`TERMINAL_MCP_SANDBOX`, `TERMINAL_MCP_NETWORK=0`, `TERMINAL_MCP_TIMEOUT_MS`, `TERMINAL_MCP_MAX_OUTPUT`,
`TERMINAL_MCP_HOST`, `TERMINAL_MCP_PORT`, `TERMINAL_MCP_TOKEN`, `TERMINAL_MCP_READ_PATHS`,
`TERMINAL_MCP_WRITE_PATHS`, `TERMINAL_MCP_PASS_ENV`.

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
site/index.html       landing page (terminal-mcp.pages.dev)
wrangler.jsonc        Pages project config
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
| Connector hangs, `/health` shows `agents` > 1 | two agents are fighting over the socket — `pkill -f dist/relay-agent.js`, then start `terminal-mcp` once |
| Server won't start on `0.0.0.0` | pass `--token`, or set `TERMINAL_MCP_ALLOW_INSECURE=1` |
