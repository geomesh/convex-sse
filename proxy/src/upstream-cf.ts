import type { UpstreamSocket } from "@geomesh/convex-sse-protocol";

export interface UpstreamHandlers {
  onOpen(): void;
  onText(data: string): void;
  onClose(code: number, reason: string): void;
}

export function cfConnectUpstream(backend: string, handlers: UpstreamHandlers): UpstreamSocket {
  const httpUrl = backend.replace(/^ws/, "http");
  let closed = false;
  const close = (code: number, reason: string): void => {
    if (closed) return;
    closed = true;
    handlers.onClose(code, reason);
  };

  const socket = fetch(httpUrl, { headers: { Upgrade: "websocket" } })
    .then((res) => {
      const ws = res.webSocket;
      if (!ws) {
        close(1006, `upstream did not upgrade (status ${res.status})`);
        return null;
      }
      ws.accept();
      ws.addEventListener("message", (event) => {
        if (typeof event.data === "string") handlers.onText(event.data);
      });
      ws.addEventListener("close", (event) => close(event.code, event.reason));
      ws.addEventListener("error", () => close(1006, "upstream error"));
      handlers.onOpen();
      return ws;
    })
    .catch((error) => {
      close(1006, String(error));
      return null;
    });

  return {
    sendText: (data) => void socket.then((ws) => ws?.send(data)),
    close: (code, reason) => void socket.then((ws) => ws?.close(code, reason)),
  };
}
