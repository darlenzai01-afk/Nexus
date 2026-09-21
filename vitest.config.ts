import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const resolveFromRoot = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  // Tests always run against workspace package *sources* (not built dist),
  // so `pnpm test` works on a fresh clone without a build step.
  resolve: {
    alias: {
      "@nexus/app": resolveFromRoot("./apps/nexus/src/index.ts"),
      "@nexus/config": resolveFromRoot("./packages/config/src/index.ts"),
      "@nexus/db": resolveFromRoot("./packages/db/src/index.ts"),
      "@nexus/storage": resolveFromRoot("./packages/storage/src/index.ts"),
      "@nexus/jobs": resolveFromRoot("./packages/jobs/src/index.ts"),
      "@nexus/providers": resolveFromRoot("./packages/providers/src/index.ts"),
      "@nexus/research": resolveFromRoot("./packages/research/src/index.ts"),
      "@nexus/script": resolveFromRoot("./packages/script/src/index.ts"),
      "@nexus/scenes": resolveFromRoot("./packages/scenes/src/index.ts"),
      "@nexus/characters": resolveFromRoot("./packages/characters/src/index.ts"),
      "@nexus/render": resolveFromRoot("./packages/render/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
