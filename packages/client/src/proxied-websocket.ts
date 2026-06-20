import { SseSocket, type SseSocketDeps, type SseSocketTimeouts } from "./sse-socket";

export interface ProxiedWebSocketDeps {
  EventSourceCtor?: typeof EventSource;
  fetch?: typeof fetch;
  timeouts?: SseSocketTimeouts;
}

export function createProxiedWebSocketClass(
  proxyUrl: string,
  deps?: ProxiedWebSocketDeps,
): typeof WebSocket {
  const resolved: SseSocketDeps = {
    EventSourceCtor: deps?.EventSourceCtor ?? globalThis.EventSource,
    fetch: deps?.fetch ?? globalThis.fetch.bind(globalThis),
  };
  const timeouts = deps?.timeouts;

  class ProxiedWebSocket extends SseSocket {
    constructor(url: string | URL, _protocols?: string | string[]) {
      super(proxyUrl, resolved, typeof url === "string" ? url : url.toString(), timeouts);
    }
  }

  return ProxiedWebSocket as unknown as typeof WebSocket;
}
