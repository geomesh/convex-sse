import { isBackendAllowed, parseList } from "@geomesh/convex-sse-protocol";
import { corsHeaders } from "./cors";

export { SessionDurableObject } from "./session-do";

function withCors(response: Response, cors: Record<string, string>): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(cors)) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function route(env: Env, sessionId: string, request: Request): Promise<Response> {
  return env.SESSIONS.get(env.SESSIONS.idFromName(sessionId)).fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request.headers.get("origin") ?? "", parseList(env.ALLOWED_ORIGINS));

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...cors, "content-type": "application/json" },
      });
    }

    if (url.pathname === "/sse") {
      if (request.method !== "GET") {
        return new Response("method not allowed", { status: 405, headers: cors });
      }
      const sessionId = url.searchParams.get("sessionId");
      const backend = url.searchParams.get("backend");
      if (!sessionId || !backend) {
        return new Response("missing sessionId or backend", { status: 400, headers: cors });
      }
      if (!isBackendAllowed(backend, parseList(env.ALLOWED_BACKENDS))) {
        return new Response("backend not allowed", { status: 403, headers: cors });
      }
      return withCors(await route(env, sessionId, request), cors);
    }

    if (url.pathname === "/send" || url.pathname === "/close") {
      if (request.method !== "POST") {
        return new Response("method not allowed", { status: 405, headers: cors });
      }
      const sessionId = request.headers.get("x-session-id");
      if (!sessionId) return new Response("missing session id", { status: 400, headers: cors });
      return withCors(await route(env, sessionId, request), cors);
    }

    return new Response("not found", { status: 404, headers: cors });
  },
} satisfies ExportedHandler<Env>;
