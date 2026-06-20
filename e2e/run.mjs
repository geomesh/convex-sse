// Drive a real Convex client against a real deployment, natively (control) or
// through the SSE proxy, to confirm a live query resolves over the tunnel.
// Uses the built bundle, so run `bun run build` first.
//   CONVEX_URL=https://<deployment>.convex.cloud node run.mjs [native|proxy]
import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";
import { EventSource } from "eventsource";
import { createProxiedWebSocketClass } from "../packages/client/dist/index.js";

const transport = process.argv[2] ?? "proxy";
const convexUrl = process.env.CONVEX_URL;
const proxyUrl = process.env.PROXY_URL ?? "http://127.0.0.1:8787";
const query = process.env.QUERY ?? "categories:list";

if (!convexUrl) {
  console.error("set CONVEX_URL to a Convex deployment, e.g. https://<name>.convex.cloud");
  process.exit(64);
}

const [path, name] = query.split(":");
const reference = path.split("/").reduce((api, segment) => api[segment], anyApi)[name];

const options =
  transport === "proxy"
    ? {
        webSocketConstructor: createProxiedWebSocketClass(proxyUrl, {
          EventSourceCtor: EventSource,
          fetch: globalThis.fetch.bind(globalThis),
        }),
      }
    : {};

const via = transport === "proxy" ? ` via ${proxyUrl}` : "";
console.log(`[${transport}] ${convexUrl} -> ${query}${via}`);
const client = new ConvexClient(convexUrl, options);

const deadline = setTimeout(() => {
  console.error(`[${transport}] TIMEOUT after 25s`);
  process.exit(1);
}, 25_000);

const unsubscribe = client.onUpdate(
  reference,
  {},
  async (result) => {
    clearTimeout(deadline);
    const count = Array.isArray(result) ? result.length : 1;
    console.log(`[${transport}] OK: ${query} resolved (${count} row(s))`);
    unsubscribe();
    await client.close();
    process.exit(0);
  },
  (error) => {
    clearTimeout(deadline);
    console.error(`[${transport}] query error:`, error?.message ?? error);
    process.exit(2);
  },
);
