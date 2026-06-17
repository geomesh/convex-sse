import { parseServerEvent } from "@geomesh/convex-sse-protocol";

export interface TransportDeps {
  EventSourceCtor: typeof EventSource;
  fetch: typeof fetch;
}

type Listener = (event: SimEvent) => void;
interface SimEvent {
  type: string;
  target: SimulatedWebSocket;
  data?: unknown;
  code?: number;
  reason?: string;
  wasClean?: boolean;
  message?: string;
}

// Implements the slice of WebSocket that Convex's client uses — text frames,
// on{open,message,error,close} + send/close — over an SSE stream and HTTP POSTs.
export class SimulatedWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  url: string;
  readyState = 0;

  onopen: Listener | null = null;
  onmessage: Listener | null = null;
  onclose: Listener | null = null;
  onerror: Listener | null = null;

  private readonly proxyUrl: string;
  private readonly deps: TransportDeps;
  private readonly sessionId = globalThis.crypto.randomUUID();
  private es: EventSource | null = null;
  private secret: string | null = null;
  private closeDispatched = false;
  private sendChain: Promise<void> = Promise.resolve();

  constructor(proxyUrl: string, deps: TransportDeps, url: string) {
    this.proxyUrl = proxyUrl;
    this.deps = deps;
    this.url = url;
    this.connect();
  }

  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
    if (this.readyState !== this.OPEN) {
      throw new Error("SimulatedWebSocket is not open");
    }
    if (typeof data !== "string") {
      throw new Error("SimulatedWebSocket only supports text frames");
    }
    // Serialize POSTs: parallel fetches can reorder over HTTP/2, and Convex's
    // protocol is order-sensitive (the first frame must be Connect).
    this.sendChain = this.sendChain.then(() => this.post("/send", { data }));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === this.CLOSING || this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSING;
    // Order /close behind queued /send POSTs so a frame sent just before close()
    // still reaches the proxy ahead of the upstream teardown.
    if (this.secret) {
      this.sendChain = this.sendChain.then(() => this.post("/close", { code, reason }));
    }
    this.dispatchClose(code, reason, true);
  }

  private connect(): void {
    const url = new URL("/sse", this.proxyUrl);
    url.searchParams.set("sessionId", this.sessionId);
    url.searchParams.set("backend", this.url);
    const es = new this.deps.EventSourceCtor(url.toString());
    this.es = es;
    es.onmessage = (event) => this.onServerFrame((event as MessageEvent).data as string);
    es.onerror = () => this.onTransportError("sse connection error");
  }

  private onServerFrame(raw: string): void {
    let event: ReturnType<typeof parseServerEvent>;
    try {
      event = parseServerEvent(raw);
    } catch {
      return;
    }
    switch (event.type) {
      case "open":
        this.secret = event.secret;
        break;
      case "up_open":
        this.readyState = this.OPEN;
        this.emit("open", {});
        break;
      case "msg":
        this.emit("message", { data: event.data });
        break;
      case "up_close":
        this.dispatchClose(event.code, event.reason, event.code === 1000);
        break;
    }
  }

  private onTransportError(message: string): void {
    if (this.closeDispatched) return;
    // Don't let EventSource silently reconnect: a fresh stream wouldn't carry
    // this session's secret. Close hard and let Convex reconnect instead.
    this.emit("error", { message });
    this.dispatchClose(1006, message, false);
  }

  private dispatchClose(code: number, reason: string, wasClean: boolean): void {
    if (this.closeDispatched) return;
    this.closeDispatched = true;
    this.readyState = this.CLOSED;
    this.es?.close();
    this.es = null;
    this.emit("close", { code, reason, wasClean });
  }

  private emit(type: string, props: Partial<SimEvent>): void {
    const handler = (this as Record<string, unknown>)[`on${type}`];
    if (typeof handler === "function") {
      (handler as Listener).call(this, { type, target: this, ...props });
    }
  }

  private post(path: string, body: unknown): Promise<void> {
    return this.deps
      .fetch(new URL(path, this.proxyUrl).toString(), {
        method: "POST",
        keepalive: true,
        headers: {
          "content-type": "application/json",
          "x-session-id": this.sessionId,
          "x-session-secret": this.secret ?? "",
        },
        body: JSON.stringify(body),
      })
      .then((res) => {
        if (!res.ok) throw new Error(`proxy ${path} responded ${res.status}`);
      })
      .catch((error) => this.onTransportError(String(error)));
  }
}
