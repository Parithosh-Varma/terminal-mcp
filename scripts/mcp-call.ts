import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Call one tool over streamable HTTP and print the raw result.
 *
 *   npx tsx scripts/mcp-call.ts <mcp-url> <tool> ['{"arg":"value"}']
 */
const [url, tool, rawArgs] = process.argv.slice(2);

if (!url || !tool) {
  console.error(`usage: tsx scripts/mcp-call.ts <mcp-url> <tool> ['{"arg":"value"}']`);
  process.exit(1);
}

const args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
const transport = new StreamableHTTPClientTransport(new URL(url));
const client = new Client({ name: "mcp-call", version: "1.0.0" });

await client.connect(transport);
const result = await client.callTool({ name: tool, arguments: args });
console.log(JSON.stringify(result, null, 2));
await client.close();
process.exit((result as { isError?: boolean }).isError ? 1 : 0);
