import { describe, expect, it, vi } from "vitest";
import { createSseStream } from "../src/sse";

const decode = (chunk: Uint8Array | undefined) => new TextDecoder().decode(chunk);

describe("createSseStream", () => {
  it("emits a keepalive comment on the interval and stops on close", async () => {
    vi.useFakeTimers();
    try {
      const { stream, sink } = createSseStream(1000);
      const reader = stream.getReader();

      vi.advanceTimersByTime(1000);
      expect(decode((await reader.read()).value)).toBe(": ping\n\n");

      sink.close();
      vi.advanceTimersByTime(5000);
      expect((await reader.read()).done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("encodes server events as SSE data frames", async () => {
    const { stream, sink } = createSseStream(60_000);
    const reader = stream.getReader();
    sink.send({ type: "up_open" });
    expect(decode((await reader.read()).value)).toBe('data: {"type":"up_open"}\n\n');
  });
});
