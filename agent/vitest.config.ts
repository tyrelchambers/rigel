import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The agent is a standalone npm project, but it consumes a few pure helpers from
 * the shared `@rigel/k8s` package by source. tsc resolves the import via the
 * `paths` alias in tsconfig.json; mirror that alias here so vitest (Vite's
 * resolver) finds the same source files at test runtime. Image bundling for the
 * deployed agent is handled separately (Task 3).
 */
export default defineConfig({
  resolve: {
    alias: {
      "@rigel/k8s/src": fileURLToPath(new URL("../packages/k8s/src", import.meta.url)),
    },
  },
});
