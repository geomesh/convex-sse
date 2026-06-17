import type { ClientClose, ClientSend, ServerEvent } from "./messages";

export interface UpstreamSocket {
  sendText(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface SseSink {
  send(event: ServerEvent): void;
  close(): void;
}

export interface SessionBridgeOptions {
  secret: string;
  sink: SseSink;
}

export class SessionBridge {
  private upstream: UpstreamSocket | null = null;
  private upstreamOpen = false;
  private closed = false;
  private readonly queue: string[] = [];

  constructor(private readonly options: SessionBridgeOptions) {}

  start(): void {
    if (this.closed) return;
    this.options.sink.send({ type: "open", secret: this.options.secret });
  }

  attachUpstream(upstream: UpstreamSocket): void {
    this.upstream = upstream;
  }

  handleUpstreamOpen(): void {
    if (this.closed) return;
    this.upstreamOpen = true;
    this.options.sink.send({ type: "up_open" });
    this.flush();
  }

  handleUpstreamText(data: string): void {
    if (this.closed) return;
    this.options.sink.send({ type: "msg", data });
  }

  handleUpstreamClose(code: number, reason: string): void {
    if (this.closed) return;
    this.options.sink.send({ type: "up_close", code, reason });
    this.dispose();
  }

  submit(send: ClientSend): void {
    if (this.closed) return;
    if (this.upstream && this.upstreamOpen) this.upstream.sendText(send.data);
    else this.queue.push(send.data);
  }

  closeFromClient(close: ClientClose): void {
    if (this.closed) return;
    this.upstream?.close(close.code, close.reason);
    this.dispose();
  }

  abort(): void {
    if (this.closed) return;
    this.upstream?.close(1001, "client disconnected");
    this.dispose();
  }

  private flush(): void {
    if (!this.upstream || !this.upstreamOpen) return;
    for (const data of this.queue) this.upstream.sendText(data);
    this.queue.length = 0;
  }

  private dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.options.sink.close();
  }
}
