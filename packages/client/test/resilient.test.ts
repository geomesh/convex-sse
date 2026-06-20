import { afterEach, describe, expect, it, vi } from "vitest";
import {
  convexSyncUrl,
  createConvexTransport,
  pickWebSocketConstructor,
  readTransportOverride,
} from "../src/resilient";

const Proxied = class {} as unknown as typeof WebSocket;

function fakeWs(behavior: "open" | "error" | "close" | "dead"): typeof WebSocket {
  return class {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(public url: string) {
      if (behavior === "open") setTimeout(() => this.onopen?.(), 0);
      if (behavior === "error") setTimeout(() => this.onerror?.(), 0);
      if (behavior === "close") setTimeout(() => this.onclose?.(), 0);
    }
    close() {}
  } as unknown as typeof WebSocket;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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
    const result = await pickWebSocketConstructor({ ...base, nativeWebSocket: fakeWs("open") });
    expect(result).not.toBe(Proxied);
  });

  it("falls back to proxy when the probe errors", async () => {
    const result = await pickWebSocketConstructor({ ...base, nativeWebSocket: fakeWs("error") });
    expect(result).toBe(Proxied);
  });

  it("falls back to proxy via onclose, not the timeout", async () => {
    vi.useFakeTimers();
    try {
      const p = pickWebSocketConstructor({
        ...base,
        nativeWebSocket: fakeWs("close"),
        timeoutMs: 10_000,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(await p).toBe(Proxied);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to proxy when the probe times out", async () => {
    const result = await pickWebSocketConstructor({
      ...base,
      nativeWebSocket: fakeWs("dead"),
      timeoutMs: 10,
    });
    expect(result).toBe(Proxied);
  });

  it("honors an explicit override without probing", async () => {
    const native = fakeWs("dead");
    expect(
      await pickWebSocketConstructor({ ...base, nativeWebSocket: native, override: "native" }),
    ).toBe(native);
    expect(
      await pickWebSocketConstructor({ ...base, nativeWebSocket: native, override: "proxy" }),
    ).toBe(Proxied);
  });

  it("warns only when the probe falls back to the proxy", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await pickWebSocketConstructor({ ...base, nativeWebSocket: fakeWs("open") });
    expect(warn).not.toHaveBeenCalled();

    await pickWebSocketConstructor({ ...base, nativeWebSocket: fakeWs("dead"), override: "proxy" });
    expect(warn).not.toHaveBeenCalled();

    await pickWebSocketConstructor({ ...base, nativeWebSocket: fakeWs("error") });
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("createConvexTransport", () => {
  const base = { convexUrl: "https://dep.convex.cloud", version: "1.38.0" };

  it("returns undefined when no proxy is configured", async () => {
    expect(await createConvexTransport({ ...base })).toBeUndefined();
  });

  it("honors ?transport=proxy without probing", async () => {
    vi.stubGlobal("WebSocket", fakeWs("dead"));
    const result = await createConvexTransport({
      ...base,
      proxyUrl: "https://proxy.example",
      search: "?transport=proxy",
    });
    expect(typeof result).toBe("function");
    expect(result).not.toBe(globalThis.WebSocket);
  });

  it("probes and selects native on an open network", async () => {
    const native = fakeWs("open");
    vi.stubGlobal("WebSocket", native);
    const result = await createConvexTransport({
      ...base,
      proxyUrl: "https://proxy.example",
      search: "",
    });
    expect(result).toBe(native);
  });

  it("probes and selects proxy behind a WS-stripping firewall", async () => {
    vi.stubGlobal("WebSocket", fakeWs("error"));
    const result = await createConvexTransport({
      ...base,
      proxyUrl: "https://proxy.example",
      search: "",
    });
    expect(typeof result).toBe("function");
    expect(result).not.toBe(globalThis.WebSocket);
  });
});
