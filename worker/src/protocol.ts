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
