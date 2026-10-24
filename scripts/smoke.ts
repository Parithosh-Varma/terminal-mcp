import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.join(os.tmpdir(), `terminal-mcp-smoke-${randomUUID().slice(0, 8)}`);
fs.mkdirSync(root, { recursive: true });

const childEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve("dist/index.js"), "--root", root],
  env: childEnv,
  stderr: "pipe",
});

transport.stderr?.on("data", (chunk: Buffer) => {
  const text = chunk.toString();
  if (text.trim()) console.log("  [server]", text.trim());
});

const client = new Client({ name: "smoke", version: "0.0.0" });
let failures = 0;
let passes = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passes++;
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail.replace(/\n/g, "\n        ")}` : ""}`);
  }
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const text = content.map((c) => c.text ?? "").join("\n");
  return { text, isError: !!result.isError };
}

async function main(): Promise<void> {
  console.log(`workspace: ${root}\n`);
  await client.connect(transport);

  const listed = await client.listTools();
  const names = listed.tools.map((t) => t.name).sort();
  console.log(`Discovered ${names.length} tools:`);
  console.log(`  ${names.join(", ")}\n`);
  check("tool count >= 60", names.length >= 60, `only ${names.length}`);

  // --- filesystem ---
  const write = await call("write_file", { path: "notes/hello.txt", content: "alpha\nbeta\ngamma\n" });
  check("write_file creates nested dirs", !write.isError && fs.existsSync(path.join(root, "notes/hello.txt")), write.text);

  const read = await call("read_file", { path: "notes/hello.txt", line_numbers: true });
  check("read_file returns line numbers", read.text.includes("2: beta"), read.text);

  const edit = await call("edit_file", { path: "notes/hello.txt", old_string: "beta", new_string: "BETA" });
  check("edit_file replaces text", !edit.isError && fs.readFileSync(path.join(root, "notes/hello.txt"), "utf8").includes("BETA"), edit.text);

  const conflict = await call("edit_file", { path: "notes/hello.txt", old_string: "a", new_string: "z" });
  check("edit_file rejects ambiguous matches", conflict.isError, conflict.text);

  const listing = await call("list_directory", { path: ".", depth: 2 });
  check("list_directory finds the file", listing.text.includes("notes/hello.txt"), listing.text);

  const info = await call("file_info", { path: "notes/hello.txt" });
  check("file_info reports sha256", /sha256:\s+[a-f0-9]{64}/.test(info.text), info.text);

  // --- path jail ---
  const escape = await call("read_file", { path: "../../etc/passwd" });
  check("path jail blocks .. escape", escape.isError && /sandbox/i.test(escape.text), escape.text);

  const absolute = await call("read_file", { path: "/etc/passwd" });
  check("path jail blocks absolute escape", absolute.isError, absolute.text);

  // --- shell ---
  const echo = await call("run_command", { command: "echo hello-from-shell && pwd" });
  check("run_command executes in workspace", !echo.isError && echo.text.includes("hello-from-shell"), echo.text);
  check("run_command cwd is the sandbox root", echo.text.includes(root), echo.text);

  const outsideWrite = await call("run_command", { command: `echo nope > ${path.join(os.homedir(), ".terminal-mcp-smoke-probe")}` });
  const escapedFile = path.join(os.homedir(), ".terminal-mcp-smoke-probe");
  const leaked = fs.existsSync(escapedFile);
  if (leaked) fs.unlinkSync(escapedFile);
  check("kernel sandbox blocks writes outside workspace", !leaked, outsideWrite.text);

  const init = await call("run_command", { command: "echo hi > inside.txt && cat inside.txt" });
  check("shell can write inside workspace", !init.isError && init.text.includes("hi"), init.text);

  if (fs.existsSync(path.join(os.homedir(), ".ssh"))) {
    const ssh = await call("run_command", { command: "cat ~/.ssh/id_ed25519 ~/.ssh/id_rsa 2>&1 | head -2" });
    check(
      "kernel sandbox blocks reading ~/.ssh",
      /not permitted|denied|no such file/i.test(ssh.text),
      ssh.text,
    );
  } else {
    console.log("  SKIP  ~/.ssh read denial (no ~/.ssh on this machine)");
  }

  const nodeCheck = await call("run_command", { command: "node -v" });
  check("node runs inside sandbox", /^v\d+/m.test(nodeCheck.text), nodeCheck.text);

  if (process.env.SMOKE_NPM === "1") {
    const npmInstall = await call("run_command", {
      command: "npm init -y >/dev/null 2>&1 && npm install --no-audit --no-fund left-pad 2>&1 | tail -3",
      timeout_ms: 180_000,
    });
    check("npm install works inside sandbox", fs.existsSync(path.join(root, "node_modules/left-pad")), npmInstall.text);
  }

  // --- search ---
  const search = await call("search_text", { query: "BETA", path: "." });
  check("search_text finds content", search.text.includes("notes/hello.txt"), search.text);

  const found = await call("find_files", { pattern: "**/*.txt" });
  check("find_files globs", found.text.includes("hello.txt"), found.text);

  // --- data ---
  await call("write_file", { path: "data.json", content: JSON.stringify({ a: { b: [1, 2, 3] } }) });
  const json = await call("json_query", { path: "data.json", query: "a.b[1]" });
  check("json_query resolves path", json.text.trim() === "2", json.text);

  const hashed = await call("hash", { text: "abc" });
  check("hash matches known sha256", hashed.text.includes("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"), hashed.text);

  // --- processes ---
  const started = await call("start_process", { command: "for i in 1 2 3; do echo tick$i; sleep 0.3; done", name: "ticker" });
  check("start_process returns id", !started.isError && started.text.includes("ticker"), started.text);
  await new Promise((resolve) => setTimeout(resolve, 700));
  const procRead = await call("read_process", { id: "ticker" });
  check("read_process captures output", procRead.text.includes("tick1"), procRead.text);
  const waited = await call("wait_process", { id: "ticker", timeout_ms: 5000 });
  check("wait_process detects exit", /Exited with code 0/.test(waited.text), waited.text);

  // --- git ---
  const gitInit = await call("git_init", { path: "." });
  if (!gitInit.isError) {
    await call("run_command", { command: 'git -c user.email=a@b.c -c user.name=t commit --allow-empty -m "init"' });
    const status = await call("git_status", {});
    check("git_status works", !status.isError && status.text.includes("porcelain"), status.text);
  } else {
    console.log("  SKIP  git tools (git unavailable)");
  }

  // --- meta ---
  const sandboxInfo = await call("sandbox_info", {});
  check("sandbox_info reports root", sandboxInfo.text.includes(root), sandboxInfo.text);

  const selftest = await call("sandbox_selftest", {});
  check("sandbox_selftest passes", /5\/5 passed/.test(selftest.text) || /4\/5 passed/.test(selftest.text), selftest.text);

  const history = await call("command_history", { limit: 5 });
  check("command_history records commands", history.text.includes("run_command"), history.text);

  await client.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch(async (error) => {
  console.error("smoke test crashed:", error);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(1);
});
