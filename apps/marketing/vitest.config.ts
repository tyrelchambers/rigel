import { defineConfig } from "vitest/config";

// The marketing site is static Astro; the only unit-tested code is the
// build-time release resolver (src/lib/releases.ts), pure TS that runs in node.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
