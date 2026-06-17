import { describe, expect, it } from "vitest";
import { isBackendAllowed, isOriginAllowed, parseList } from "../src/allowlist";

describe("parseList", () => {
  it("splits, trims, and drops empties", () => {
    expect(parseList(" a, b ,,c ")).toEqual(["a", "b", "c"]);
    expect(parseList(undefined)).toEqual([]);
  });
});

describe("isBackendAllowed", () => {
  it("matches a subdomain wildcard but not the bare apex", () => {
    expect(isBackendAllowed("wss://happy.convex.cloud/s", ["*.convex.cloud"])).toBe(true);
    expect(isBackendAllowed("wss://convex.cloud/s", ["*.convex.cloud"])).toBe(false);
  });

  it("matches multi-level subdomains and ignores path/query", () => {
    expect(isBackendAllowed("wss://a.b.convex.cloud/s", ["*.convex.cloud"])).toBe(true);
    expect(isBackendAllowed("wss://x.convex.cloud/api/1/sync?foo=bar", ["*.convex.cloud"])).toBe(
      true,
    );
  });

  it("matches an exact host", () => {
    expect(isBackendAllowed("wss://a.b/s", ["a.b"])).toBe(true);
    expect(isBackendAllowed("wss://c.b/s", ["a.b"])).toBe(false);
  });

  it("rejects non-ws schemes and unparseable backends", () => {
    expect(isBackendAllowed("https://happy.convex.cloud", ["*.convex.cloud"])).toBe(false);
    expect(isBackendAllowed("not a url", ["*.convex.cloud"])).toBe(false);
  });
});

describe("isOriginAllowed", () => {
  it("honors wildcard and exact origins", () => {
    expect(isOriginAllowed("https://a.com", ["*"])).toBe(true);
    expect(isOriginAllowed("https://a.com", ["https://a.com"])).toBe(true);
    expect(isOriginAllowed("https://b.com", ["https://a.com"])).toBe(false);
  });
});
