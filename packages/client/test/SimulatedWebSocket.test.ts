import type { ServerEvent } from "@geomesh/convex-sse-protocol";
import { describe, expect, it } from "vitest";
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
}

function setup() {
  FakeEventSource.instances = [];
  const posts: Post[] = [];
  let failNext = false;
  const fetch = (async (url: string, init: RequestInit) => {
    posts.push({
      url,
      body: JSON.parse(init.body as string),
      headers: init.headers as Record<string, string>,
    });
    return { ok: !failNext, status: failNext ? 500 : 204 } as Response;
  }) as unknown as typeof globalThis.fetch;

  const deps: TransportDeps = {
    EventSourceCtor: FakeEventSource as unknown as typeof EventSource,
    fetch,
  };
  const ws = new SimulatedWebSocket("https://proxy", deps, "wss://x.convex.cloud/api/1.38.0/sync");
  return {
    ws,
    posts,
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
  });

  it("throws when send() is called before open", () => {
    const s = setup();
    expect(() => s.ws.send("x")).toThrow();
  });

  it("rejects binary frames", () => {
    const s = setup();
    open(s);
    expect(() => s.ws.send(new Uint8Array([1]))).toThrow(/text frames/);
  });

  it("POSTs sends as {data} with the session id + secret, serialized in order", async () => {
    const s = setup();
    open(s);
    s.ws.send("one");
    s.ws.send("two");
    await flush();
    expect(s.posts.map((p) => p.url)).toEqual(["https://proxy/send", "https://proxy/send"]);
    expect(s.posts.map((p) => p.body)).toEqual([{ data: "one" }, { data: "two" }]);
    expect(s.posts[0]?.headers["x-session-id"]).toMatch(/.+/);
    expect(s.posts[0]?.headers["x-session-secret"]).toBe("sek");
  });

  it("delivers upstream text via onmessage", () => {
    const s = setup();
    open(s);
    const received: unknown[] = [];
    s.ws.onmessage = (event) => received.push(event.data);
    s.es().emit({ type: "msg", data: "from-convex" });
    expect(received).toEqual(["from-convex"]);
  });

  it("ignores malformed server frames", () => {
    const s = setup();
    open(s);
    expect(() => s.es().raw("not json")).not.toThrow();
  });

  it("POSTs /close and fires a clean onclose on close()", async () => {
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
  });

  it("orders the /close POST behind a frame sent just before close()", async () => {
    const s = setup();
    open(s);
    s.ws.send("last");
    s.ws.close(1000, "bye");
    await flush();
    expect(s.posts.map((p) => p.url)).toEqual(["https://proxy/send", "https://proxy/close"]);
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
