import { createProxiedWebSocketClass, type ProxiedWebSocketDeps } from "./proxied-websocket";

export type Transport = "native" | "proxy";

export interface PickTransportOptions {
  probeUrl: string;
  nativeWebSocket?: typeof WebSocket;
  proxiedWebSocket: typeof WebSocket;
  timeoutMs?: number;
  override?: Transport | null;
}

export function convexSyncUrl(convexUrl: string, version: string): string {
  const i = convexUrl.indexOf("://");
  if (i === -1) throw new Error("convexUrl must be an absolute URL");
  const origin = convexUrl.substring(i + 3);
  const protocol = convexUrl.substring(0, i);
  const wsProtocol = protocol === "http" ? "ws" : "wss";
  return `${wsProtocol}://${origin}/api/${version}/sync`;
}

export function readTransportOverride(search: string): Transport | null {
  const value = new URLSearchParams(search).get("transport");
  return value === "native" || value === "proxy" ? value : null;
}

function probe(probeUrl: string, Native: typeof WebSocket, timeoutMs: number): Promise<Transport> {
  return new Promise((resolve) => {
    let settled = false;
    let socket: WebSocket | null = null;
    const finish = (transport: Transport) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket) {
        socket.onopen = null;
        socket.onerror = null;
        socket.onclose = null;
        try {
          socket.close();
        } catch {}
      }
      resolve(transport);
    };
    const timer = setTimeout(() => finish("proxy"), timeoutMs);
    try {
      socket = new Native(probeUrl);
    } catch {
      finish("proxy");
      return;
    }
    socket.onopen = () => finish("native");
    socket.onerror = () => finish("proxy");
    socket.onclose = () => finish("proxy");
  });
}

export async function pickWebSocketConstructor(
  options: PickTransportOptions,
): Promise<typeof WebSocket> {
  const native = options.nativeWebSocket ?? globalThis.WebSocket;
  if (!native) return options.proxiedWebSocket;
  if (options.override) {
    return options.override === "native" ? native : options.proxiedWebSocket;
  }
  if ((await probe(options.probeUrl, native, options.timeoutMs ?? 3000)) === "native") {
    return native;
  }
  console.warn("[convex-sse] native WebSocket unreachable, falling back to the SSE proxy");
  return options.proxiedWebSocket;
}

export interface ConvexTransportOptions {
  convexUrl: string;
  version: string;
  proxyUrl?: string;
  search?: string;
  timeoutMs?: number;
  proxiedDeps?: ProxiedWebSocketDeps;
}

export async function createConvexTransport(
  options: ConvexTransportOptions,
): Promise<typeof WebSocket | undefined> {
  if (!options.proxyUrl) return undefined;
  return pickWebSocketConstructor({
    probeUrl: convexSyncUrl(options.convexUrl, options.version),
    proxiedWebSocket: createProxiedWebSocketClass(options.proxyUrl, options.proxiedDeps),
    override: readTransportOverride(options.search ?? defaultSearch()),
    timeoutMs: options.timeoutMs,
  });
}

function defaultSearch(): string {
  return typeof location !== "undefined" ? location.search : "";
}
