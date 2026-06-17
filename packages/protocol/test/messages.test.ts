import { describe, expect, it } from "vitest";
import { encodeServerEvent, parseClientSend, parseServerEvent } from "../src/messages";

describe("server events", () => {
  it("encodes as an SSE data frame", () => {
    expect(encodeServerEvent({ type: "up_open" })).toBe('data: {"type":"up_open"}\n\n');
  });

  it.each([
    { type: "open", secret: "abc" },
    { type: "up_open" },
    { type: "msg", data: "hello" },
    { type: "up_close", code: 1006, reason: "gone" },
  ] as const)("round-trips %o through encode/parse", (event) => {
    const frame = encodeServerEvent(event)
      .replace(/^data: /, "")
      .trimEnd();
    expect(parseServerEvent(frame)).toEqual(event);
  });

  it("rejects unknown types and non-objects", () => {
    expect(() => parseServerEvent('{"type":"nope"}')).toThrow();
    expect(() => parseServerEvent('"x"')).toThrow();
  });
});

describe("client sends", () => {
  it("parses and narrows to just data", () => {
    expect(parseClientSend({ data: "x", seq: 5 })).toEqual({ data: "x" });
  });

  it("rejects payloads without string data", () => {
    expect(() => parseClientSend({ data: 5 })).toThrow();
    expect(() => parseClientSend(null)).toThrow();
  });
});
