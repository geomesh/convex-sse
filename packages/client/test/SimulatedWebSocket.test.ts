import type { ServerEvent } from "@geomesh/convex-sse-protocol";
import { describe, expect, it, vi } from "vitest";
import { SimulatedWebSocket, type TransportDeps } from "../src/SimulatedWebSocket";

class FakeEventSource {
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  static instances: FakeEventSource[] = [];

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
  emit(event: ServerEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  raw(data: string): void {
    this.onmessage?.({ data });
  }
  fail(): void {
    this.onerror?.();
  }
  static get last(): FakeEventSource {
    const es = FakeEventSource.instances.at(-1);
    if (!es) throw new Error("no EventSource created");
    return es;
  }
}

interface Post {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  keepalive: boolean;
  hasSignal: boolean;
}

function setup(opts?: {
  manualPosts?: boolean;
  parkUntilAbort?: boolean;
  connectMs?: number;
  postMs?: number;
}) {
  FakeEventSource.instances = [];
  const posts: Post[] = [];
  // manualPosts parks each fetch until released, to prove send serialization.
  const releases: Array<(ok?: boolean) => void> = [];
  let failNext = false;
  const fetch = (async (url: string, init: RequestInit) => {
    posts.push({
      url,
      body: JSON.parse(init.body as string),
      headers: init.headers as Record<string, string>,
      keepalive: init.keepalive ?? false,
      hasSignal: init.signal != null,
    });
    if (opts?.parkUntilAbort) {
      // Never responds; only rejects when the per-POST AbortSignal fires.
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    }
    if (opts?.manualPosts) {
      return new Promise<Response>((resolve) => {
        releases.push((ok = true) => resolve({ ok, status: ok ? 204 : 500 } as Response));
      });
    }
    return { ok: !failNext, status: failNext ? 500 : 204 } as Response;
  }) as unknown as typeof globalThis.fetch;

  const deps: TransportDeps = {
    EventSourceCtor: FakeEventSource as unknown as typeof EventSource,
    fetch,
  };
  const ws = new SimulatedWebSocket("https://proxy", deps, "wss://x.convex.cloud/api/1.38.0/sync", {
    connectMs: opts?.connectMs,
    postMs: opts?.postMs,
  });
  return {
    ws,
    posts,
    releases,
    es: () => FakeEventSource.last,
    setFail: (value: boolean) => {
      failNext = value;
    },
  };
}

function open(s: ReturnType<typeof setup>): void {
  s.es().emit({ type: "open", secret: "sek" });
  s.es().emit({ type: "up_open" });
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("SimulatedWebSocket", () => {
  it("opens an SSE stream to /sse carrying the backend", () => {
    const s = setup();
    expect(s.es().url).toContain("/sse");
    expect(s.es().url).toContain("backend=wss");
    s.ws.close();
  });

  it("goes OPEN and fires onopen on up_open", () => {
    const s = setup();
    let opened = false;
    s.ws.onopen = () => {
      opened = true;
    };
    expect(s.ws.readyState).toBe(s.ws.CONNECTING);
    open(s);
    expect(opened).toBe(true);
    expect(s.ws.readyState).toBe(s.ws.OPEN);
    s.ws.close();
  });

  it("throws when send() is called before open", () => {
    const s = setup();
    expect(() => s.ws.send("x")).toThrow();
    s.ws.close();
  });

  it("rejects binary frames", () => {
    const s = setup();
    open(s);
    expect(() => s.ws.send(new Uint8Array([1]))).toThrow(/text frames/);
    s.ws.close();
  });

  it("POSTs sends as {data} with the session id + secret, no keepalive, with a timeout signal", async () => {
    const s = setup();
    open(s);
    s.ws.send("one");
    await flush();
    expect(s.posts.map((p) => p.url)).toEqual(["https://proxy/send"]);
    expect(s.posts.map((p) => p.body)).toEqual([{ data: "one" }]);
    expect(s.posts[0]?.headers["x-session-id"]).toMatch(/.+/);
    expect(s.posts[0]?.headers["x-session-secret"]).toBe("sek");
    expect(s.posts[0]?.keepalive).toBe(false);
    expect(s.posts[0]?.hasSignal).toBe(true);
    s.ws.close();
  });

  it("serializes /send POSTs: the next is not issued until the previous resolves", async () => {
    const s = setup({ manualPosts: true });
    open(s);
    s.ws.send("one");
    s.ws.send("two");
    await flush();
    expect(s.posts.map((p) => p.body)).toEqual([{ data: "one" }]);
    s.releases[0]?.();
    await flush();
    expect(s.posts.map((p) => p.body)).toEqual([{ data: "one" }, { data: "two" }]);
    s.releases[1]?.();
  });

  it("delivers upstream text via onmessage", () => {
    const s = setup();
    open(s);
    const received: unknown[] = [];
    s.ws.onmessage = (event) => received.push(event.data);
    s.es().emit({ type: "msg", data: "from-convex" });
    expect(received).toEqual(["from-convex"]);
    s.ws.close();
  });

  it("treats a throwing message handler as a transport error (1006), not a silent swallow", () => {
    const s = setup();
    open(s);
    const order: string[] = [];
    s.ws.onmessage = () => {
      throw new Error("convex rejected an out-of-order frame");
    };
    s.ws.onerror = () => order.push("error");
    s.ws.onclose = (event) => order.push(`close:${event.code}`);
    s.es().emit({ type: "msg", data: "x" });
    expect(order).toEqual(["error", "close:1006"]);
    expect(s.ws.readyState).toBe(s.ws.CLOSED);
  });

  it("ignores malformed server frames", () => {
    const s = setup();
    open(s);
    expect(() => s.es().raw("not json")).not.toThrow();
    s.ws.close();
  });

  it("POSTs /close with keepalive and fires a clean onclose on close()", async () => {
    const s = setup();
    open(s);
    let closed: { code?: number; wasClean?: boolean } | null = null;
    s.ws.onclose = (event) => {
      closed = { code: event.code, wasClean: event.wasClean };
    };
    s.ws.close(1000, "bye");
    expect(s.ws.readyState).toBe(s.ws.CLOSED);
    expect(closed).toEqual({ code: 1000, wasClean: true });
    await flush();
    expect(s.posts.at(-1)?.url).toBe("https://proxy/close");
    expect(s.posts.at(-1)?.body).toEqual({ code: 1000, reason: "bye" });
    expect(s.posts.at(-1)?.keepalive).toBe(true);
  });

  it("orders the /close POST behind a frame sent just before close()", async () => {
    const s = setup({ manualPosts: true });
    open(s);
    s.ws.send("last");
    s.ws.close(1000, "bye");
    await flush();
    expect(s.posts.map((p) => p.url)).toEqual(["https://proxy/send"]);
    s.releases[0]?.();
    await flush();
    expect(s.posts.map((p) => p.url)).toEqual(["https://proxy/send", "https://proxy/close"]);
    s.releases[1]?.();
  });

  it("maps upstream close to onclose with the upstream code", () => {
    const s = setup();
    open(s);
    let code: number | null = null;
    s.ws.onclose = (event) => {
      code = event.code ?? null;
    };
    s.es().emit({ type: "up_close", code: 4040, reason: "gone" });
    expect(code).toBe(4040);
    expect(s.es().closed).toBe(true);
  });

  it("fires onerror then a 1006 onclose on transport failure", () => {
    const s = setup();
    open(s);
    const order: string[] = [];
    s.ws.onerror = () => order.push("error");
    s.ws.onclose = (event) => order.push(`close:${event.code}`);
    s.es().fail();
    expect(order).toEqual(["error", "close:1006"]);
  });

  it("aborts a black-holed /send after postMs and tears down with 1006", async () => {
    const s = setup({ parkUntilAbort: true, postMs: 10 });
    open(s);
    let code: number | null = null;
    s.ws.onclose = (event) => {
      code = event.code ?? null;
    };
    s.ws.send("x");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(code).toBe(1006);
    expect(s.ws.readyState).toBe(s.ws.CLOSED);
  });

  it("fires onerror+1006 onclose and tears down when a /send POST fails", async () => {
    const s = setup();
    open(s);
    const order: string[] = [];
    s.ws.onerror = () => order.push("error");
    s.ws.onclose = (event) => order.push(`close:${event.code}`);
    s.setFail(true);
    s.ws.send("x");
    await flush();
    expect(order).toEqual(["error", "close:1006"]);
    expect(s.ws.readyState).toBe(s.ws.CLOSED);
    expect(s.es().closed).toBe(true);
  });

  // The must-not-hang contract: a transport failure BEFORE the upstream opens
  // (readyState still CONNECTING) must still reach Convex as an onclose.
  it("fires a 1006 onclose when the transport fails before open", () => {
    const s = setup();
    let closed: number | null = null;
    s.ws.onclose = (event) => {
      closed = event.code ?? null;
    };
    s.es().fail();
    expect(closed).toBe(1006);
    expect(s.ws.readyState).toBe(s.ws.CLOSED);
  });

  it("fires a 1006 onclose if up_open never arrives within connectMs", () => {
    vi.useFakeTimers();
    try {
      const s = setup({ connectMs: 1000 });
      let closed: number | null = null;
      s.ws.onclose = (event) => {
        closed = event.code ?? null;
      };
      expect(s.ws.readyState).toBe(s.ws.CONNECTING);
      vi.advanceTimersByTime(1000);
      expect(closed).toBe(1006);
      expect(s.ws.readyState).toBe(s.ws.CLOSED);
      expect(s.es().closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire the connect watchdog once up_open arrives", () => {
    vi.useFakeTimers();
    try {
      const s = setup({ connectMs: 1000 });
      let closeCount = 0;
      s.ws.onclose = () => closeCount++;
      open(s);
      vi.advanceTimersByTime(5000);
      expect(closeCount).toBe(0);
      expect(s.ws.readyState).toBe(s.ws.OPEN);
      s.ws.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes cleanly and tears down the stream when close() is called before open", async () => {
    const s = setup();
    let closed: { code?: number; wasClean?: boolean } | null = null;
    s.ws.onclose = (event) => {
      closed = { code: event.code, wasClean: event.wasClean };
    };
    s.ws.close();
    await flush();
    expect(closed).toEqual({ code: 1000, wasClean: true });
    expect(s.ws.readyState).toBe(s.ws.CLOSED);
    expect(s.es().closed).toBe(true);
    // No secret yet, so no /close POST is sent; the proxy tears down via the
    // SSE stream cancel instead.
    expect(s.posts).toHaveLength(0);
  });

  it("dispatches close only once when an upstream close is followed by a transport error", () => {
    const s = setup();
    open(s);
    let closeCount = 0;
    let errorCount = 0;
    s.ws.onclose = () => closeCount++;
    s.ws.onerror = () => errorCount++;
    s.es().emit({ type: "up_close", code: 1000, reason: "" });
    s.es().fail();
    expect(closeCount).toBe(1);
    expect(errorCount).toBe(0);
  });
});
