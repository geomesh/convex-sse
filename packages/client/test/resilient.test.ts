import { describe, expect, it } from "vitest";
import {
  convexSyncUrl,
  pickWebSocketConstructor,
  readTransportOverride,
  type StorageLike,
} from "../src/resilient";

function memoryStorage(initial?: Record<string, string>): StorageLike {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

const Proxied = class {} as unknown as typeof WebSocket;

function fakeWs(behavior: "open" | "error" | "dead"): typeof WebSocket {
  return class {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) {
      if (behavior === "open") setTimeout(() => this.onopen?.(), 0);
      if (behavior === "error") setTimeout(() => this.onerror?.(), 0);
    }
    close() {}
  } as unknown as typeof WebSocket;
}

describe("convexSyncUrl", () => {
  it("maps https deployment to the wss sync path", () => {
    expect(convexSyncUrl("https://happy.convex.cloud", "1.38.0")).toBe(
      "wss://happy.convex.cloud/api/1.38.0/sync",
    );
  });
  it("maps http to ws for local dev", () => {
    expect(convexSyncUrl("http://127.0.0.1:3210", "1.38.0")).toBe(
      "ws://127.0.0.1:3210/api/1.38.0/sync",
    );
  });
});

describe("readTransportOverride", () => {
  it("reads ?transport=proxy", () => {
    expect(readTransportOverride("?transport=proxy")).toBe("proxy");
  });
  it("ignores unknown values", () => {
    expect(readTransportOverride("?transport=carrier-pigeon")).toBeNull();
  });
});

describe("pickWebSocketConstructor", () => {
  const base = { probeUrl: "wss://dep.convex.cloud/api/1/sync", proxiedWebSocket: Proxied };

  it("returns native when the probe opens", async () => {
    const native = fakeWs("open");
    const storage = memoryStorage();
    const result = await pickWebSocketConstructor({ ...base, nativeWebSocket: native, storage });
    expect(result).toBe(native);
    expect(storage.getItem("convex-sse:transport")).toBe("native");
  });

  it("falls back to proxy when the probe errors", async () => {
    const native = fakeWs("error");
    const result = await pickWebSocketConstructor({ ...base, nativeWebSocket: native });
    expect(result).toBe(Proxied);
  });

  it("falls back to proxy when the probe times out", async () => {
    const native = fakeWs("dead");
    const result = await pickWebSocketConstructor({
      ...base,
      nativeWebSocket: native,
      timeoutMs: 10,
    });
    expect(result).toBe(Proxied);
  });

  it("uses the cached decision without probing", async () => {
    const native = fakeWs("dead");
    const storage = memoryStorage({ "convex-sse:transport": "native" });
    const result = await pickWebSocketConstructor({ ...base, nativeWebSocket: native, storage });
    expect(result).toBe(native);
  });

  it("honors an explicit override and caches it", async () => {
    const native = fakeWs("open");
    const storage = memoryStorage();
    const result = await pickWebSocketConstructor({
      ...base,
      nativeWebSocket: native,
      storage,
      override: "proxy",
    });
    expect(result).toBe(Proxied);
    expect(storage.getItem("convex-sse:transport")).toBe("proxy");
  });
});
