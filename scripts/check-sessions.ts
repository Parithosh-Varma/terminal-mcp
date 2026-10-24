import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv[2];
if (!url) {
  console.error("usage: tsx scripts/check-sessions.ts <mcp-url>");
  process.exit(1);
}

type Result = { isError?: boolean; content?: Array<{ type: string; text?: string }> };

async function open(sessionUrl: string) {
  const transport = new StreamableHTTPClientTransport(new URL(sessionUrl));
  const client = new Client({ name: "sessions-check", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as Result;
  const text = (result.content ?? []).map((c) => c.text ?? "").join("").trim();
  return { text, isError: !!result.isError };
}

const a = await open(url);
const aPwd = await call(a, "run_command", { command: "pwd" });
const aWrite = await call(a, "write_file", { path: "owner.txt", content: "session-a" });

const b = await open(url);
const bPwd = await call(b, "run_command", { command: "pwd" });
const bList = await call(b, "list_directory", { path: "." });
const bEscape = await call(b, "read_file", { path: "../sand1/owner.txt" });

const dirA = aPwd.text.split("\n").pop() ?? "";
const dirB = bPwd.text.split("\n").pop() ?? "";
const separate = dirA !== dirB;
const emptyB = !bList.text.includes("owner.txt");
const blocked = bEscape.isError || bEscape.text.includes("escapes the sandbox");

const rows: Array<[string, boolean, string]> = [
  ["session A has its own directory", /sand\d+$/.test(dirA), dirA],
  ["session B has a different directory", separate, dirB],
  ["A's file is not visible in B", emptyB, emptyB ? "(clean)" : bList.text],
  ["B cannot reach into A by path", blocked, bEscape.text.split("\n")[0] ?? ""],
  ["write in A succeeded", !aWrite.isError, aWrite.text.split("\n")[0] ?? ""],
];

for (const [name, pass, detail] of rows) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

await a.close();
await b.close();

const failed = rows.filter(([, pass]) => !pass).length;
console.log(`\n${rows.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
