import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

const BACKEND = "wss://echo.convex.cloud/api/1.38.0/sync";
// Must satisfy the worker's pinned ALLOWED_BACKENDS for full-path (SELF) tests.
const ALLOWED_BACKEND = "wss://clean-lobster-724.eu-west-1.convex.cloud/api/1.38.0/sync";

// Stand in for the upstream Convex deployment: intercept the DO's outbound
// `fetch(Upgrade)` and return a 101 + WebSocketPair that echoes text frames.
function mockUpstreamEcho(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("not found", { status: 404 });
    }
    const { 0: server, 1: client } = new WebSocketPair();
    server.accept();
    server.addEventListener("message", (event) => server.send(event.data));
    return new Response(null, { status: 101, webSocket: client });
  });
}

interface SseReader {
  next(): Promise<Record<string, unknown>>;
  cancel(): Promise<void>;
}

function readEvents(response: Response): SseReader {
  if (!response.body) throw new Error("response has no body");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const queue: Record<string, unknown>[] = [];

  async function pump(): Promise<void> {
    const { value, done } = await reader.read();
    if (done) throw new Error("sse stream ended");
    buffer += value;
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5))
        .join("\n");
      if (data) queue.push(JSON.parse(data));
      boundary = buffer.indexOf("\n\n");
    }
  }

  return {
    async next() {
      while (queue.length === 0) await pump();
      const event = queue.shift();
      if (!event) throw new Error("no event");
      return event;
    },
    async cancel() {
      await reader.cancel();
    },
  };
}

function sessionStub(id: string): DurableObjectStub {
  return env.SESSIONS.get(env.SESSIONS.idFromName(id));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("worker routing", () => {
  it("serves /health", async () => {
    const res = await SELF.fetch("https://proxy.example/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("answers CORS preflight", async () => {
    const res = await SELF.fetch("https://proxy.example/send", { method: "OPTIONS" });
    expect(res.status).toBe(204);
  });

  it("rejects a backend outside the allowlist with 403", async () => {
    const res = await SELF.fetch(
      "https://proxy.example/sse?sessionId=a&backend=wss%3A%2F%2Fevil.example.com",
    );
    expect(res.status).toBe(403);
  });

  it("rejects /sse missing params with 400", async () => {
    const res = await SELF.fetch("https://proxy.example/sse?sessionId=a");
    expect(res.status).toBe(400);
  });

  it("rejects /send without a session id with 400", async () => {
    const res = await SELF.fetch("https://proxy.example/send", { method: "POST" });
    expect(res.status).toBe(400);
  });
});

describe("session round-trip", () => {
  it("opens, signals upstream, echoes a frame, and closes", async () => {
    mockUpstreamEcho();
    const stub = sessionStub("round-trip");

    const sse = await stub.fetch(`https://do/sse?sessionId=round-trip&backend=${BACKEND}`);
    expect(sse.status).toBe(200);
    expect(sse.headers.get("content-type")).toBe("text/event-stream");
    const events = readEvents(sse);

    const open = await events.next();
    expect(open.type).toBe("open");
    expect(typeof open.secret).toBe("string");
    const secret = open.secret as string;

    expect(await events.next()).toEqual({ type: "up_open" });

    const sent = await stub.fetch("https://do/send", {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-secret": secret },
      body: JSON.stringify({ data: "hello convex" }),
    });
    expect(sent.status).toBe(204);

    expect(await events.next()).toEqual({ type: "msg", data: "hello convex" });

    const closed = await stub.fetch("https://do/close", {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-secret": secret },
      body: JSON.stringify({ code: 1000, reason: "done" }),
    });
    expect(closed.status).toBe(204);
    await events.cancel();
  });

  it("rejects a /send with a bad secret", async () => {
    mockUpstreamEcho();
    const stub = sessionStub("bad-secret");
    const sse = await stub.fetch(`https://do/sse?sessionId=bad-secret&backend=${BACKEND}`);
    const events = readEvents(sse);
    await events.next();

    const res = await stub.fetch("https://do/send", {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-secret": "wrong" },
      body: JSON.stringify({ data: "nope" }),
    });
    expect(res.status).toBe(401);
    await events.cancel();
  });

  it("emits up_close 1006 when the upstream does not upgrade", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad gateway", { status: 502 }));
    const stub = sessionStub("no-upgrade");
    const sse = await stub.fetch(`https://do/sse?sessionId=no-upgrade&backend=${BACKEND}`);
    const events = readEvents(sse);
    expect((await events.next()).type).toBe("open");
    const close = await events.next();
    expect(close.type).toBe("up_close");
    expect(close.code).toBe(1006);
    await events.cancel();
  });

  it("gracefully closes the open upstream (no abort/reset) with the client's code+reason", async () => {
    let serverClose: { code: number; reason: string } | null = null;
    let aborted = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input as RequestInfo, init);
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("not found", { status: 404 });
      }
      // Aborting after upgrade would reset the socket instead of closing cleanly.
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      const { 0: server, 1: client } = new WebSocketPair();
      server.accept();
      server.addEventListener("close", (event) => {
        serverClose = { code: event.code, reason: event.reason };
      });
      return new Response(null, { status: 101, webSocket: client });
    });

    const stub = sessionStub("graceful-close");
    const sse = await stub.fetch(`https://do/sse?sessionId=graceful-close&backend=${BACKEND}`);
    const events = readEvents(sse);
    const secret = (await events.next()).secret as string;
    expect(await events.next()).toEqual({ type: "up_open" });

    const closed = await stub.fetch("https://do/close", {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-secret": secret },
      body: JSON.stringify({ code: 1000, reason: "bye" }),
    });
    expect(closed.status).toBe(204);
    await vi.waitFor(() => expect(serverClose).not.toBeNull());
    expect(serverClose).toEqual({ code: 1000, reason: "bye" });
    expect(aborted).toBe(false);
  });

  it("buffers sends that arrive before upstream open, then flushes in order", async () => {
    let acceptUpstream = (): void => {};
    const gate = new Promise<void>((resolve) => {
      acceptUpstream = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input as RequestInfo, init);
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("not found", { status: 404 });
      }
      await gate;
      const { 0: server, 1: client } = new WebSocketPair();
      server.accept();
      server.addEventListener("message", (event) => server.send(event.data));
      return new Response(null, { status: 101, webSocket: client });
    });

    const stub = sessionStub("buffered");
    const sse = await stub.fetch(`https://do/sse?sessionId=buffered&backend=${BACKEND}`);
    const events = readEvents(sse);
    const open = await events.next();
    const secret = open.secret as string;

    for (const data of ["one", "two", "three"]) {
      await stub.fetch("https://do/send", {
        method: "POST",
        headers: { "content-type": "application/json", "x-session-secret": secret },
        body: JSON.stringify({ data }),
      });
    }

    acceptUpstream();
    expect(await events.next()).toEqual({ type: "up_open" });
    expect(await events.next()).toEqual({ type: "msg", data: "one" });
    expect(await events.next()).toEqual({ type: "msg", data: "two" });
    expect(await events.next()).toEqual({ type: "msg", data: "three" });
    await events.cancel();
  });
});

// SELF drives the real Worker — the only path that covers withCors over a live
// SSE body and session-id routing (the DO-stub tests above bypass both).
describe("full worker path", () => {
  it("streams open/up_open/msg through withCors and routes /send by session id", async () => {
    mockUpstreamEcho();
    const sessionId = "self-e2e";
    const sse = await SELF.fetch(
      `https://proxy.example/sse?sessionId=${sessionId}&backend=${encodeURIComponent(ALLOWED_BACKEND)}`,
    );
    expect(sse.status).toBe(200);
    // withCors must preserve the SSE headers, not drop them in the re-wrap.
    expect(sse.headers.get("content-type")).toBe("text/event-stream");
    expect(sse.headers.get("x-accel-buffering")).toBe("no");

    const events = readEvents(sse);
    const open = await events.next();
    expect(open.type).toBe("open");
    const secret = open.secret as string;
    expect(await events.next()).toEqual({ type: "up_open" });

    const sent = await SELF.fetch("https://proxy.example/send", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": sessionId,
        "x-session-secret": secret,
      },
      body: JSON.stringify({ data: "hello" }),
    });
    expect(sent.status).toBe(204);
    // If withCors buffered the stream, this frame would never arrive.
    expect(await events.next()).toEqual({ type: "msg", data: "hello" });
    await events.cancel();
  });

  it("403s a disallowed Origin once ALLOWED_ORIGINS is configured", async () => {
    const prev = env.ALLOWED_ORIGINS;
    env.ALLOWED_ORIGINS = "https://app.example";
    try {
      const res = await SELF.fetch(
        `https://proxy.example/sse?sessionId=o&backend=${encodeURIComponent(ALLOWED_BACKEND)}`,
        { headers: { origin: "https://evil.example" } },
      );
      expect(res.status).toBe(403);
    } finally {
      env.ALLOWED_ORIGINS = prev;
    }
  });

  it("never 403s a no-Origin request or /health, even with ALLOWED_ORIGINS configured", async () => {
    mockUpstreamEcho();
    const prev = env.ALLOWED_ORIGINS;
    env.ALLOWED_ORIGINS = "https://app.example";
    try {
      const sse = await SELF.fetch(
        `https://proxy.example/sse?sessionId=no-origin&backend=${encodeURIComponent(ALLOWED_BACKEND)}`,
      );
      expect(sse.status).toBe(200);
      await sse.body?.cancel();
      const health = await SELF.fetch("https://proxy.example/health", {
        headers: { origin: "https://evil.example" },
      });
      expect(health.status).toBe(200);
    } finally {
      env.ALLOWED_ORIGINS = prev;
    }
  });

  it("allows any Origin under the default wildcard ALLOWED_ORIGINS", async () => {
    mockUpstreamEcho();
    const sse = await SELF.fetch(
      `https://proxy.example/sse?sessionId=wild&backend=${encodeURIComponent(ALLOWED_BACKEND)}`,
      { headers: { origin: "https://anything.example" } },
    );
    expect(sse.status).toBe(200);
    await sse.body?.cancel();
  });
});
