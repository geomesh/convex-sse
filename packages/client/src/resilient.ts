export type Transport = "native" | "proxy";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface PickTransportOptions {
  probeUrl: string;
  nativeWebSocket?: typeof WebSocket;
  proxiedWebSocket: typeof WebSocket;
  timeoutMs?: number;
  storage?: StorageLike | null;
  storageKey?: string;
  override?: Transport | null;
}

const DEFAULT_KEY = "convex-sse:transport";

export function convexSyncUrl(convexUrl: string, version: string): string {
  const i = convexUrl.search("://");
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
  });
}

export async function pickWebSocketConstructor(
  options: PickTransportOptions,
): Promise<typeof WebSocket> {
  const native = options.nativeWebSocket ?? globalThis.WebSocket;
  const key = options.storageKey ?? DEFAULT_KEY;
  const pick = (t: Transport) => (t === "native" ? native : options.proxiedWebSocket);

  if (!native) return options.proxiedWebSocket;

  if (options.override) {
    options.storage?.setItem(key, options.override);
    return pick(options.override);
  }

  const cached = options.storage?.getItem(key);
  if (cached === "native" || cached === "proxy") return pick(cached);

  const decision = await probe(options.probeUrl, native, options.timeoutMs ?? 3000);
  options.storage?.setItem(key, decision);
  return pick(decision);
}
