import { DurableObject } from "cloudflare:workers";
import { parseClientSend, SessionBridge } from "@geomesh/convex-sse-protocol";
import { randomSecret, timingSafeEqual } from "./secret";
import { createSseStream, SSE_HEADERS } from "./sse";
import { connectUpstream } from "./upstream";

export class SessionDurableObject extends DurableObject<Env> {
  private bridge: SessionBridge | null = null;
  private secret = "";

  fetch(request: Request): Response | Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/sse":
        return this.handleSse(url);
      case "/send":
        return this.handleSend(request);
      case "/close":
        return this.handleClose(request);
      default:
        return new Response("not found", { status: 404 });
    }
  }

  private handleSse(url: URL): Response {
    const backend = url.searchParams.get("backend");
    if (!backend) return new Response("missing backend", { status: 400 });

    this.bridge?.abort();
    this.secret = randomSecret();
    const { stream, sink, onCancel } = createSseStream();
    const bridge = new SessionBridge({
      secret: this.secret,
      sink: {
        send: (event) => sink.send(event),
        close: () => {
          sink.close();
          if (this.bridge === bridge) this.bridge = null;
        },
      },
    });
    const upstream = connectUpstream(backend, {
      onOpen: () => bridge.handleUpstreamOpen(),
      onText: (data) => bridge.handleUpstreamText(data),
      onClose: (code, reason) => bridge.handleUpstreamClose(code, reason),
    });
    bridge.attachUpstream(upstream);
    bridge.start();
    this.bridge = bridge;
    // Ignore a stale cancel once a newer /sse has replaced the bridge.
    onCancel(() => {
      if (this.bridge === bridge) {
        bridge.abort();
        this.bridge = null;
      }
    });

    return new Response(stream, { status: 200, headers: SSE_HEADERS });
  }

  private async handleSend(request: Request): Promise<Response> {
    const bridge = this.authorize(request);
    if (bridge instanceof Response) return bridge;
    let send: ReturnType<typeof parseClientSend>;
    try {
      send = parseClientSend(await request.json());
    } catch {
      return new Response("bad payload", { status: 400 });
    }
    bridge.submit(send);
    return new Response(null, { status: 204 });
  }

  private async handleClose(request: Request): Promise<Response> {
    const bridge = this.authorize(request);
    if (bridge instanceof Response) return bridge;
    const body = (await request.json().catch(() => ({}))) as { code?: number; reason?: string };
    bridge.closeFromClient(body);
    return new Response(null, { status: 204 });
  }

  private authorize(request: Request): SessionBridge | Response {
    if (!this.bridge) return new Response("no session", { status: 404 });
    if (!timingSafeEqual(request.headers.get("x-session-secret") ?? "", this.secret)) {
      return new Response("bad secret", { status: 401 });
    }
    return this.bridge;
  }
}
