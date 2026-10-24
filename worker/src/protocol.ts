/** Wire protocol between the Worker (relay) and the Mac agent. */

export interface RelayRequest {
  type: "request";
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface RelayResponse {
  type: "response";
  id: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type AgentMessage = RelayRequest | { type: "pong" } | { type: "hello"; version: string };

export type WorkerMessage =
  | RelayResponse
  | { type: "hello"; server: string; time: string }
  | { type: "ping" };

export const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "x-forwarded-proto",
  "x-real-ip",
]);

export function sanitizeHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase()) && !key.toLowerCase().startsWith("cf-")) {
      result[key] = value;
    }
  });
  return result;
}

export function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
    { status, headers: { "content-type": "application/json", "cache-control": "no-store" } },
  );
}

/**
 * Accept the token in whatever shape the client sends it:
 *   /mcp?token=…            /mcp?key=…          /mcp?api_key=…
 *   Authorization: Bearer   X-API-Key           X-Relay-Token
 *   /t/<token>/mcp          /<token>/mcp        /t/<token>/agent
 */
export function extractToken(request: Request, url: URL): string | null {
  const query = url.searchParams;
  for (const name of ["token", "key", "api_key", "apikey", "access_token"]) {
    const value = query.get(name);
    if (value) return value.trim();
  }

  const auth = request.headers.get("authorization");
  if (auth) {
    const match = auth.match(/^(?:Bearer|Token|ApiKey|Basic)\s+(.+)$/i);
    if (match) return match[1].trim();
  }

  for (const header of ["x-api-key", "x-relay-token", "x-auth-token", "api-key"]) {
    const value = request.headers.get(header);
    if (value) return value.trim();
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length >= 3 && parts[0] === "t") return parts[1];
  if (parts.length === 2) return parts[0];
  return null;
}

/** Collapse token-in-path URLs onto the canonical routes. */
export function canonicalPath(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length >= 3 && parts[0] === "t" && (parts[2] === "mcp" || parts[2] === "agent")) {
    return `/${parts[2]}`;
  }
  if (parts.length === 2 && ["mcp", "agent", "health"].includes(parts[1])) {
    return `/${parts[1]}`;
  }
  return parts.length ? `/${parts.join("/")}` : "/";
}
