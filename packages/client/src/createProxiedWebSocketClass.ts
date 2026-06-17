import { SimulatedWebSocket, type TransportDeps } from "./SimulatedWebSocket";

export interface ProxiedWebSocketDeps {
  EventSourceCtor?: typeof EventSource;
  fetch?: typeof fetch;
}

export function createProxiedWebSocketClass(
  proxyUrl: string,
  deps?: ProxiedWebSocketDeps,
): typeof WebSocket {
  const resolved: TransportDeps = {
    EventSourceCtor: deps?.EventSourceCtor ?? globalThis.EventSource,
    fetch: deps?.fetch ?? globalThis.fetch.bind(globalThis),
  };

  class ProxiedWebSocket extends SimulatedWebSocket {
    constructor(url: string | URL, _protocols?: string | string[]) {
      super(proxyUrl, resolved, typeof url === "string" ? url : url.toString());
    }
  }

  return ProxiedWebSocket as unknown as typeof WebSocket;
}
