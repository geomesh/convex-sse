# convex-sse

Keep Convex apps working for users behind firewalls that block WebSockets.

Convex's reactive client talks to `wss://<deployment>.convex.cloud/api/<version>/sync`
over a single WebSocket. Some corporate/DPI firewalls strip the `Upgrade`
handshake, and Convex ships no HTTP fallback. This repo tunnels that exact
WebSocket over **SSE + HTTP POST**, which sails through those firewalls —
preserving live queries, mutations, **and** auth, not a degraded read-only mode.

The only app change is one option on the Convex client:

```ts
new ConvexReactClient(url, { webSocketConstructor });
```

## How it works

```
browser (firewalled)                    Cloudflare                 Convex
┌──────────────────────┐  SSE (GET /sse) ┌──────────────────┐  wss  ┌──────────┐
│ ConvexReactClient    │ ───────────────►│ Worker (router)  │ ────► │ deploy   │
│  webSocketConstructor│  POST /send     │   ▼ by sessionId │       │ /api/sync│
│  = ProxiedWebSocket  │ ◄───────────────│ Durable Object   │ ◄──── │          │
└──────────────────────┘   plain HTTPS   │  (1 per session) │       └──────────┘
                                         └──────────────────┘
```

- The **client** swaps in a `WebSocket`-compatible class that opens an
  `EventSource` to the proxy (server→client frames) and `POST`s outgoing frames.
- The **Worker** routes each session to a **Durable Object**, the single point of
  coordination the separate `/sse` and `/send` requests need.
- The **DO** opens the real upstream WebSocket to Convex and bridges the two.

A boot-time probe picks native-vs-proxy once per session, so users on open
networks keep native WebSockets with no penalty.

Three packages: `@geomesh/convex-sse` (the client, install in apps),
`@geomesh/convex-sse-protocol` (pure wire protocol + bridge, bundled into the
other two), and `@geomesh/convex-sse-proxy` (the Worker, in `proxy/`).

## Deploy the proxy

```sh
cd proxy
bun x wrangler deploy
# ALLOWED_BACKENDS defaults to *.convex.cloud; set ALLOWED_ORIGINS to your origins
```

One deployment fronts every project — each app passes its own deployment as the
`backend` query param, allowlisted so the proxy can't be used as an open relay.
Develop locally with `bun run dev` (the same workerd runtime as production).

HTTP surface: `GET /sse?backend&sessionId` streams the server→client frames
(`open{secret}`, `up_open`, `msg{data}`, `up_close{code,reason}`); `POST /send`
and `POST /close` carry the client→server direction, routed to the session's
Durable Object by `x-session-id` and authorized by the per-session `secret`
(delivered only in the `open` event) sent back in the `x-session-secret` header;
`GET /health` is liveness.

## Wire it into an app

Install (`bun add @geomesh/convex-sse@file:../convex-sse/packages/client`), then
pick the transport at boot and hand it to Convex:

```ts
import { version } from "convex";
import { ConvexReactClient } from "convex/react";
import {
  convexSyncUrl,
  createProxiedWebSocketClass,
  pickWebSocketConstructor,
  readTransportOverride,
} from "@geomesh/convex-sse";

const webSocketConstructor = await pickWebSocketConstructor({
  probeUrl: convexSyncUrl(convexUrl, version),
  proxiedWebSocket: createProxiedWebSocketClass(sseProxyUrl),
  storage: window.sessionStorage,
  override: readTransportOverride(window.location.search),
});

const convex = new ConvexReactClient(convexUrl, { webSocketConstructor });
```

No backend, schema, hook, or component changes. Force a transport while testing
with `?transport=proxy` or `?transport=native`.

## Develop

```sh
bun install
bun run typecheck   # tsc, per package
bun run check       # biome
bun run test        # unit suites (node) + worker suite (workerd)
```

Unit tests live in each package's `test/`; the worker suite runs the real Worker
and Durable Object in workerd (`@cloudflare/vitest-pool-workers`) with the
upstream Convex socket mocked. `e2e/` drives a real client against a real
deployment — see `e2e/README.md`.

## Caveats

- **SSE buffering**: the Worker sets `text/event-stream` + `x-accel-buffering: no`
  and no compression to defeat proxy buffering; a firewall that still buffers
  can't be helped by SSE.
- **Cost**: each firewalled client holds one open SSE stream → one live Durable
  Object. Sized for a firewalled minority, not your whole audience.
- Auth tokens travel in-protocol over the tunnel (not cookies), so the
  cross-origin proxy doesn't break login.
