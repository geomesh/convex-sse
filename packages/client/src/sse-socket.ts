import { parseServerEvent } from "@geomesh/convex-sse-protocol";

export interface SseSocketDeps {
  EventSourceCtor: typeof EventSource;
  fetch: typeof fetch;
}

export interface SseSocketTimeouts {
  connectMs?: number;
  postMs?: number;
}

const DEFAULT_CONNECT_MS = 30_000;
const DEFAULT_POST_MS = 12_000;

type Listener = (event: SocketEvent) => void;
interface SocketEvent {
  type: string;
  target: SseSocket;
  data?: unknown;
  code?: number;
  reason?: string;
  wasClean?: boolean;
  message?: string;
}

export class SseSocket {
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
  private readonly deps: SseSocketDeps;
  private readonly connectMs: number;
  private readonly postMs: number;
  private readonly sessionId = globalThis.crypto.randomUUID();
  private es: EventSource | null = null;
  private secret: string | null = null;
  private closeDispatched = false;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private sendChain: Promise<void> = Promise.resolve();

  constructor(proxyUrl: string, deps: SseSocketDeps, url: string, timeouts?: SseSocketTimeouts) {
    this.proxyUrl = proxyUrl;
    this.deps = deps;
    this.url = url;
    this.connectMs = timeouts?.connectMs ?? DEFAULT_CONNECT_MS;
    this.postMs = timeouts?.postMs ?? DEFAULT_POST_MS;
    this.connect();
  }

  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
    if (this.readyState !== this.OPEN) {
      throw new Error("socket is not open");
    }
    if (typeof data !== "string") {
      throw new Error("only text frames are supported");
    }
    // Serialize POSTs: parallel fetches can reorder over HTTP/2, and Convex is
    // order-sensitive (the first frame must be Connect).
    this.sendChain = this.sendChain.then(() => this.post("/send", { data }));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === this.CLOSING || this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSING;
    // Chain /close behind queued sends so a frame sent just before close() still reaches the proxy first.
    if (this.secret) {
      this.sendChain = this.sendChain.then(() =>
        this.post("/close", { code, reason }, { keepalive: true }),
      );
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
    this.connectTimer = setTimeout(() => this.onTransportError("connect timeout"), this.connectMs);
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
        this.clearConnectTimer();
        this.readyState = this.OPEN;
        this.emit("open", {});
        break;
      case "msg":
        // A throwing handler must trigger reconnect, not be swallowed by EventSource.
        try {
          this.emit("message", { data: event.data });
        } catch {
          this.onTransportError("message handler threw");
        }
        break;
      case "up_close":
        this.dispatchClose(event.code, event.reason, event.code === 1000);
        break;
    }
  }

  private onTransportError(message: string): void {
    if (this.closeDispatched) return;
    // EventSource would auto-reconnect, but a fresh stream lacks this session's secret;
    // close hard and let Convex reconnect instead.
    this.emit("error", { message });
    this.dispatchClose(1006, message, false);
  }

  private dispatchClose(code: number, reason: string, wasClean: boolean): void {
    if (this.closeDispatched) return;
    this.closeDispatched = true;
    this.clearConnectTimer();
    this.readyState = this.CLOSED;
    this.es?.close();
    this.es = null;
    this.emit("close", { code, reason, wasClean });
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private emit(type: string, props: Partial<SocketEvent>): void {
    const handler = (this as Record<string, unknown>)[`on${type}`];
    if (typeof handler === "function") {
      (handler as Listener).call(this, { type, target: this, ...props });
    }
  }

  private post(path: string, body: unknown, opts?: { keepalive?: boolean }): Promise<void> {
    return this.deps
      .fetch(new URL(path, this.proxyUrl).toString(), {
        method: "POST",
        keepalive: opts?.keepalive ?? false,
        signal: AbortSignal.timeout(this.postMs),
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
