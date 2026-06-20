# e2e

A real Convex reactive client run against a real deployment, both natively (the
control) and through the SSE proxy, to confirm live queries resolve over the
tunnel. It uses the built client bundle, so build first.

```sh
# from the repo root
bun run build

cd e2e && bun install

# control: native WebSocket straight to Convex
CONVEX_URL=https://<deployment>.convex.cloud node run.mjs native

# through the proxy. Start wrangler dev in ../proxy first:
#   (cd ../proxy && bun x wrangler dev --port 8787)
CONVEX_URL=https://<deployment>.convex.cloud node run.mjs proxy
```

Both should report the same row count. Override the query with
`QUERY=module:function` (default `categories:list`, a public no-arg query) and
the proxy URL with `PROXY_URL`. Node has no global `EventSource`, so the script
injects the `eventsource` polyfill into `createProxiedWebSocketClass`.

The first upgrade after `wrangler dev` cold-starts can need a couple of retries
while workerd warms up; Convex's reconnect recovers in a second or two.
