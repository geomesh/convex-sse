# convex-sse

Keep Convex apps working for users behind firewalls that block WebSockets.

Convex's reactive client talks to `wss://<deployment>.convex.cloud/api/<version>/sync`
over a single WebSocket. Some corporate and DPI firewalls strip the `Upgrade`
handshake, and Convex has no HTTP fallback. This repo tunnels that WebSocket over
SSE plus HTTP POST, which gets through those firewalls. Live queries, mutations,
and auth all keep working.

The only change an app makes is one option on the Convex client:

```ts
new ConvexReactClient(url, { webSocketConstructor });
```

## How it works

```
  ┌──────────────────────────────┐
  │ Browser (WebSocket blocked)  │
  │   ConvexReactClient          │
  │   with ProxiedWebSocket      │
  │   (SSE + HTTP POST)          │
  └──────────────────────────────┘
          │   ▲
     POST │   │ SSE stream
    /send │   │ (GET /sse)
   /close ▼   │
  ┌──────────────────────────────┐
  │ Cloudflare Worker            │
  │   routes by sessionId to a   │
  │   Durable Object per session │
  └──────────────────────────────┘
          │   ▲
      wss ▼   │ wss
  ┌──────────────────────────────┐
  │ Convex deployment            │
  │   /api/<version>/sync        │
  └──────────────────────────────┘
```

- The client swaps in a `WebSocket`-compatible class. It opens an `EventSource`
  to the proxy for the server-to-client direction and POSTs outgoing frames.
- The Worker routes each session to a Durable Object, the single coordination
  point the separate `/sse` and `/send` requests share.
- The Durable Object opens the real WebSocket to Convex and bridges both directions.

A boot-time probe picks native or proxy once per session, so users on open
networks keep native WebSockets.

Three packages:

- `@geomesh/convex-sse` is the client, installed in apps.
- `@geomesh/convex-sse-protocol` is the wire protocol and bridge, bundled into the other two.
- `@geomesh/convex-sse-proxy` is the Cloudflare Worker, in `proxy/`.

## Use it in an app

```sh
bun add @geomesh/convex-sse
```

Resolve the transport at boot and pass it to Convex. `createConvexTransport`
probes native against proxy, honours a `?transport=` override, and returns
`undefined` when no proxy is configured:

```ts
import { version } from "convex";
import { ConvexReactClient } from "convex/react";
import { createConvexTransport } from "@geomesh/convex-sse";

const webSocketConstructor = await createConvexTransport({
  convexUrl,
  version,               // convex's exported version; the probe needs /api/<version>/sync
  proxyUrl: sseProxyUrl, // omit to force native (no probe)
});

const convex = new ConvexReactClient(convexUrl, { webSocketConstructor });
```

No backend, schema, hook, or component changes. Convex reads a
`webSocketConstructor` of `undefined` as native, so the same call works whether
or not a proxy is configured.

Construct the client after the `await`. The probe adds up to `timeoutMs`
(default 3s) only on a WebSocket-blocked network, so render a loading shell if
that matters to you. Force a transport while testing with `?transport=proxy` or
`?transport=native`.

## Client API

`@geomesh/convex-sse` exports:

- `createConvexTransport(options): Promise<typeof WebSocket | undefined>` is the
  high-level entry point. It returns a `WebSocket` constructor to hand to Convex,
  or `undefined` when `proxyUrl` is omitted. Options:
  - `convexUrl: string` is the deployment URL.
  - `version: string` is Convex's exported `version`, used to build the probe URL.
  - `proxyUrl?: string` is the deployed proxy origin. Omit to force native.
  - `search?: string` is the query string the `?transport=` override is read from
    (defaults to `location.search`).
  - `timeoutMs?: number` is the probe timeout (default 3000).
  - `proxiedDeps?: ProxiedWebSocketDeps` overrides `EventSource`, `fetch`, and timeouts.
- `createProxiedWebSocketClass(proxyUrl, deps?): typeof WebSocket` returns a
  `WebSocket` constructor that always uses the proxy, with no probe. Use it when
  you have already decided to proxy, or in a non-browser runtime. `deps` can
  inject `EventSourceCtor`, `fetch`, and `timeouts` (`{ connectMs, postMs }`,
  defaulting to 30s and 12s).
- `pickWebSocketConstructor(options): Promise<typeof WebSocket>` is the probe on
  its own. Given a `probeUrl`, a `proxiedWebSocket`, and optional `nativeWebSocket`,
  `timeoutMs`, and `override`, it returns native if the probe connects and the
  proxy otherwise.
- `convexSyncUrl(convexUrl, version): string` maps a deployment URL to its
  `ws(s)://.../api/<version>/sync` address.
- `readTransportOverride(search): "native" | "proxy" | null` reads `?transport=`
  from a query string.
- Types: `Transport`, `ConvexTransportOptions`, `PickTransportOptions`, `ProxiedWebSocketDeps`, `SseSocketTimeouts`.

## Deploy the proxy

```sh
cd proxy
bun x wrangler deploy
```

One deployment fronts every project. Each app passes its own deployment as the
`backend` query param, which the proxy checks against an allowlist so it can't be
used as an open relay. Two env vars control access, both with permissive defaults
so a fresh deploy works:

- `ALLOWED_BACKENDS` is a comma-separated list of host patterns the proxy will
  dial, for example `your-deployment.convex.cloud`. It supports `*.convex.cloud`
  wildcards and defaults to `*.convex.cloud`. This is the load-bearing open-relay
  control, so pin it to your own deployment before exposing the proxy publicly.
- `ALLOWED_ORIGINS` is a comma-separated list of exact browser origins (no
  wildcards, unlike `ALLOWED_BACKENDS`), or `*`. It defaults to `*`.

The committed `wrangler.jsonc` sets no `vars`, so a fresh deploy runs on those
permissive defaults. Pin `ALLOWED_BACKENDS` before exposing the proxy publicly,
either as a secret or by adding a `vars` block:

```sh
bun x wrangler secret put ALLOWED_BACKENDS
```

Change `name` and the custom-domain `routes` in `wrangler.jsonc` to your own.
Develop locally with `bun run dev`, the same workerd runtime as production.

## Proxy HTTP surface

The client opens one `GET /sse` stream per session and drives the rest by POST.

- `GET /sse?backend=<wss-url>&sessionId=<id>` opens the SSE stream of
  server-to-client events:
  - `open { secret }` carries the per-session secret, sent once.
  - `up_open` means the upstream WebSocket to Convex is open.
  - `msg { data }` is a frame from Convex.
  - `up_close { code, reason }` means the upstream closed.
- `POST /send` with body `{ data }` sends a client-to-server frame.
- `POST /close` with body `{ code?, reason? }` closes the session.
- `GET /health` returns `{ ok: true }`.

Each request reaches the session's Durable Object by `x-session-id` (or the
`sessionId` query param on `/sse`), and the POSTs are authorized by the secret in
the `x-session-secret` header.

## Develop

```sh
bun install
bun run typecheck   # tsc, per package
bun run check       # biome
bun run test        # unit suites (node) + worker suite (workerd)
```

Unit tests live in each package's `test/`. The worker suite runs the real Worker
and Durable Object in workerd (`@cloudflare/vitest-pool-workers`) with the
upstream Convex socket mocked. `e2e/` drives a real client against a real
deployment; see `e2e/README.md`.

## Caveats

- WebSocket-stripping firewalls only. This tunnels the Convex sync WebSocket
  (live queries, mutations, the `Authenticate` frame). The Convex client still
  talks plain HTTPS straight to `*.convex.cloud` for other paths, including
  `@convex-dev/auth`'s background token refresh (a direct `POST /api/action`
  through an internal `ConvexHttpClient` the transport swap can't reach). That is
  fine for a firewall that strips the WebSocket `Upgrade` but allows HTTPS. A
  firewall that blocks the `convex.cloud` domain outright leaves the app
  half-working: queries and mutations tunnel, but token refresh fails and the
  editor is silently logged out. Proxying `/api/*` is out of scope.
- Open-relay control. `ALLOWED_BACKENDS` is the real limit on which deployments
  the worker will dial, so pin it to your deployment host. `ALLOWED_ORIGINS` adds
  a browser-facing Origin gate. Both default to permissive so a starter setup
  works, so harden them before going public.
- SSE buffering. The Worker sets `text/event-stream` with `x-accel-buffering: no`
  and no compression to defeat proxy buffering. A firewall that still buffers
  can't be helped by SSE.
- Cost. Each firewalled client holds one open SSE stream and one live Durable
  Object. Size for a firewalled minority, not your whole audience.
- Auth tokens travel in-protocol over the tunnel, not in cookies, so the
  cross-origin proxy doesn't break login.
