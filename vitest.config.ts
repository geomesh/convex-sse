import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        resolve: {
          alias: {
            "@geomesh/convex-sse-protocol": fileURLToPath(
              new URL("./packages/protocol/src/index.ts", import.meta.url),
            ),
          },
        },
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts"],
          environment: "node",
        },
      },
      "./proxy/vitest.config.ts",
    ],
  },
});
