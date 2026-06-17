import { encodeServerEvent, type ServerEvent, type SseSink } from "@geomesh/convex-sse-protocol";

interface SseStream {
  stream: ReadableStream<Uint8Array>;
  sink: SseSink;
  onCancel(callback: () => void): void;
}

// Comment pings keep an idle stream under Cloudflare's 120s read timeout;
// EventSource ignores comments, so the client never sees them.
export function createSseStream(keepaliveMs = 25_000): SseStream {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let cancelled = false;
  let cancelCallback: (() => void) | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;

  const enqueue = (text: string): void => {
    if (cancelled || !controller) return;
    try {
      controller.enqueue(encoder.encode(text));
    } catch {}
  };

  const stopKeepalive = (): void => {
    if (keepalive) clearInterval(keepalive);
    keepalive = null;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      keepalive = setInterval(() => enqueue(": ping\n\n"), keepaliveMs);
    },
    cancel() {
      cancelled = true;
      stopKeepalive();
      cancelCallback?.();
    },
  });

  const sink: SseSink = {
    send(event: ServerEvent) {
      enqueue(encodeServerEvent(event));
    },
    close() {
      stopKeepalive();
      if (cancelled || !controller) return;
      try {
        controller.close();
      } catch {}
    },
  };

  return {
    stream,
    sink,
    onCancel(callback) {
      cancelCallback = callback;
    },
  };
}
