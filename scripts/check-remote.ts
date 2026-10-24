import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv[2];
if (!url) {
  console.error("usage: tsx scripts/check-remote.ts <mcp-url>");
  process.exit(1);
}

const transport = new StreamableHTTPClientTransport(new URL(url));
const client = new Client({ name: "register-check", version: "1.0.0" });

try {
  await client.connect(transport);
  console.log("initialize: ok");

  const { tools } = await client.listTools();
  console.log(`tools/list: ${tools.length} tools`);

  const result = (await client.callTool({
    name: "run_command",
    arguments: { command: "echo register-check-ok && pwd" },
  })) as { content?: Array<{ type: string; text?: string }> };
  const text = (result.content ?? []).map((c) => c.text ?? "").join("");
  console.log(`tools/call: ${text.replace(/\n/g, " | ")}`);

  console.log("\nRESULT: server registers and executes correctly");
  await client.close();
  process.exit(0);
} catch (error) {
  console.error("RESULT: failed —", (error as Error).message);
  process.exit(1);
}
