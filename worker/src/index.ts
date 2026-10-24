export { Relay } from "./relay.js";

export interface Env {
  RELAY: DurableObjectNamespace;
  RELAY_TOKEN?: string;
  RELAY_NAME?: string;
}

import { canonicalPath, extractToken } from "./protocol.js";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorized(request: Request, env: Env): boolean {
  // Fail closed: a relay without a shared secret would be an open shell.
  if (!env.RELAY_TOKEN) return false;
  const provided = extractToken(request, new URL(request.url));
  return !!provided && timingSafeEqual(provided, env.RELAY_TOKEN);
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message:
          "Unauthorized. Provide the relay token as ?token=…, an Authorization: Bearer header, " +
          "an X-API-Key header, or in the path: /t/<token>/mcp",
      },
      id: null,
    }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": 'Bearer realm="terminal-mcp"',
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      },
    },
  );
}

const LANDING = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>terminal-mcp relay</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #0b0d10; color: #e6e8eb;
    font: 15px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  main { width: min(640px, 92vw); }
  h1 { font-size: 20px; letter-spacing: -0.02em; margin: 0 0 4px; }
  .sub { color: #7d8590; margin-bottom: 28px; }
  .card { border: 1px solid #21262d; border-radius: 10px; padding: 18px 20px; background: #0f1216; }
  .row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #161b22; }
  .row:last-child { border-bottom: 0; }
  .k { color: #7d8590; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 8px; background: #f85149; }
  .dot.on { background: #3fb950; box-shadow: 0 0 8px #3fb95066; }
  code { background: #161b22; padding: 2px 6px; border-radius: 5px; font-size: 13px; }
  a { color: #58a6ff; }
  footer { margin-top: 22px; color: #484f58; font-size: 13px; }
</style>
</head>
<body>
<main>
  <h1>terminal-mcp relay</h1>
  <div class="sub">Cloudflare Worker bridging ChatGPT to a sandboxed Mac terminal.</div>
  <div class="card">
    <div class="row"><span class="k">agent</span><span><span class="dot" id="dot"></span><span id="state">checking…</span></span></div>
    <div class="row"><span class="k">endpoint</span><code>/mcp</code></div>
    <div class="row"><span class="k">transport</span><span>streamable HTTP · JSON</span></div>
    <div class="row"><span class="k">version</span><span id="ver">–</span></div>
  </div>
  <footer>Connect ChatGPT with <code>/mcp?token=…</code> · start the agent with <code>npm run relay</code></footer>
</main>
<script>
  async function poll() {
    try {
      const res = await fetch('/health', { cache: 'no-store' });
      const data = await res.json();
      document.getElementById('dot').className = 'dot' + (data.online ? ' on' : '');
      document.getElementById('state').textContent = data.online
        ? (data.connectedSince ? 'connected since ' + new Date(data.connectedSince).toLocaleTimeString() : 'connected')
        : 'offline — run the agent on your Mac';
      document.getElementById('ver').textContent = data.agentVersion || '–';
    } catch {
      document.getElementById('state').textContent = 'unreachable';
    }
  }
  poll();
  setInterval(poll, 10000);
</script>
</body>
</html>`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = canonicalPath(url.pathname);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
          "access-control-allow-headers":
            "Content-Type, Authorization, X-API-Key, X-Relay-Token, Mcp-Session-Id, MCP-Protocol-Version",
          "access-control-expose-headers": "Mcp-Session-Id",
        },
      });
    }

    if (path === "/" && request.method === "GET") {
      return new Response(LANDING, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (path === "/health") {
      const response = await env.RELAY.get(env.RELAY.idFromName("default")).fetch(request);
      // Public status page lives on another origin (terminal-mcp.pages.dev).
      const headers = new Headers(response.headers);
      headers.set("access-control-allow-origin", "*");
      headers.set("cache-control", "no-store");
      return new Response(response.body, { status: response.status, headers });
    }

    if (path !== "/mcp" && path !== "/agent") {
      return new Response("not found\n", { status: 404 });
    }

    if (!authorized(request, env)) return unauthorized();

    return env.RELAY.get(env.RELAY.idFromName("default")).fetch(request);
  },
} satisfies ExportedHandler<Env>;
