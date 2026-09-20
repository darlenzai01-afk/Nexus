import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const resolveFromRoot = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  // Tests always run against workspace package *sources* (not built dist),
  // so `pnpm test` works on a fresh clone without a build step.
  resolve: {
    alias: {
      "@nexus/config": resolveFromRoot("./packages/config/src/index.ts"),
      "@nexus/app": resolveFromRoot("./apps/nexus/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
