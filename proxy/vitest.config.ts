import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/worker.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    name: "worker",
    include: ["test/**/*.test.ts"],
    // DO WebSockets aren't supported under per-file storage isolation.
    isolate: false,
  },
});
