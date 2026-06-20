import type { UpstreamSocket } from "@geomesh/convex-sse-protocol";

export interface UpstreamHandlers {
  onOpen(): void;
  onText(data: string): void;
  onClose(code: number, reason: string): void;
}

const CONNECT_TIMEOUT_MS = 10_000;

export function cfConnectUpstream(backend: string, handlers: UpstreamHandlers): UpstreamSocket {
  const httpUrl = backend.replace(/^ws/, "http");
  const controller = new AbortController();
  let ws: WebSocket | null = null;
  let closed = false;
  const emitClose = (code: number, reason: string): void => {
    if (closed) return;
    closed = true;
    handlers.onClose(code, reason);
  };

  const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);

  fetch(httpUrl, { headers: { Upgrade: "websocket" }, signal: controller.signal })
    .then((res) => {
      clearTimeout(timer);
      const socket = res.webSocket;
      if (!socket) {
        emitClose(1006, `upstream did not upgrade (status ${res.status})`);
        return;
      }
      socket.accept();
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") handlers.onText(event.data);
      });
      socket.addEventListener("close", (event) => emitClose(event.code, event.reason));
      socket.addEventListener("error", () => emitClose(1006, "upstream error"));
      ws = socket;
      handlers.onOpen();
    })
    .catch((error) => {
      clearTimeout(timer);
      emitClose(1006, controller.signal.aborted ? "upstream connect timeout" : String(error));
    });

  return {
    sendText: (data) => {
      try {
        ws?.send(data);
      } catch {}
    },
    close: (code, reason) => {
      if (!ws) {
        controller.abort();
        return;
      }
      try {
        ws.close(code, reason);
      } catch {
        ws.close();
      }
    },
  };
}
