import { isOriginAllowed } from "@geomesh/convex-sse-protocol";

export function corsHeaders(origin: string, allowedOrigins: string[]): Record<string, string> {
  if (!origin || !isOriginAllowed(origin, allowedOrigins)) return { vary: "origin" };
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-session-id, x-session-secret",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}
