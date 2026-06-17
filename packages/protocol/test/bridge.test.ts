import { describe, expect, it } from "vitest";
import { SessionBridge, type SseSink, type UpstreamSocket } from "../src/bridge";
import type { ServerEvent } from "../src/messages";

function harness() {
  const events: ServerEvent[] = [];
  let sinkClosed = false;
  const sink: SseSink = {
    send: (event) => events.push(event),
    close: () => {
      sinkClosed = true;
    },
  };

  const sent: string[] = [];
  let upstreamClose: { code?: number; reason?: string } | null = null;
  const upstream: UpstreamSocket = {
    sendText: (data) => sent.push(data),
    close: (code, reason) => {
      upstreamClose = { code, reason };
    },
  };

  const bridge = new SessionBridge({ secret: "shh", sink });
  bridge.attachUpstream(upstream);
  return {
    bridge,
    events,
    sent,
    get sinkClosed() {
      return sinkClosed;
    },
    get upstreamClose() {
      return upstreamClose;
    },
  };
}

describe("SessionBridge", () => {
  it("emits open with the secret on start", () => {
    const h = harness();
    h.bridge.start();
    expect(h.events[0]).toEqual({ type: "open", secret: "shh" });
  });

  it("forwards upstream open and text to the sink", () => {
    const h = harness();
    h.bridge.start();
    h.bridge.handleUpstreamOpen();
    h.bridge.handleUpstreamText("hi");
    expect(h.events).toContainEqual({ type: "up_open" });
    expect(h.events).toContainEqual({ type: "msg", data: "hi" });
  });

  it("buffers client sends until upstream open, then flushes in order", () => {
    const h = harness();
    h.bridge.start();
    h.bridge.submit({ data: "a" });
    h.bridge.submit({ data: "b" });
    expect(h.sent).toEqual([]);
    h.bridge.handleUpstreamOpen();
    expect(h.sent).toEqual(["a", "b"]);
  });

  it("sends straight through once upstream is open", () => {
    const h = harness();
    h.bridge.start();
    h.bridge.handleUpstreamOpen();
    h.bridge.submit({ data: "x" });
    expect(h.sent).toEqual(["x"]);
  });

  it("propagates upstream close and closes the sink", () => {
    const h = harness();
    h.bridge.start();
    h.bridge.handleUpstreamOpen();
    h.bridge.handleUpstreamClose(1000, "bye");
    expect(h.events).toContainEqual({ type: "up_close", code: 1000, reason: "bye" });
    expect(h.sinkClosed).toBe(true);
  });

  it("propagates an upstream close that arrives before upstream open", () => {
    const h = harness();
    h.bridge.start();
    h.bridge.handleUpstreamClose(1006, "upstream error");
    expect(h.events).toContainEqual({ type: "up_close", code: 1006, reason: "upstream error" });
    expect(h.sinkClosed).toBe(true);
  });

  it("tears down upstream on client close", () => {
    const h = harness();
    h.bridge.start();
    h.bridge.handleUpstreamOpen();
    h.bridge.closeFromClient({ code: 1000, reason: "done" });
    expect(h.upstreamClose).toEqual({ code: 1000, reason: "done" });
    expect(h.sinkClosed).toBe(true);
  });

  it("aborts upstream with a going-away code", () => {
    const h = harness();
    h.bridge.start();
    h.bridge.handleUpstreamOpen();
    h.bridge.abort();
    expect(h.upstreamClose).toEqual({ code: 1001, reason: "client disconnected" });
  });

  it("ignores events and sends after close", () => {
    const h = harness();
    h.bridge.start();
    h.bridge.handleUpstreamOpen();
    h.bridge.handleUpstreamClose(1000, "bye");
    const count = h.events.length;
    h.bridge.handleUpstreamText("late");
    h.bridge.submit({ data: "late" });
    expect(h.events).toHaveLength(count);
    expect(h.sent).toEqual([]);
  });
});
