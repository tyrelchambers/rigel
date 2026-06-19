/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Default to node; component tests opt into jsdom via a `@vitest-environment
  // jsdom` file directive (keeps the pure-logic .test.ts suites in fast node).
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@helmsman/k8s": path.resolve(__dirname, "../../packages/k8s/src/index.ts"),
      "@helmsman/catalog": path.resolve(__dirname, "../../packages/catalog/src/index.ts"),
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:8787",
      "/ws": { target: "ws://localhost:8787", ws: true },
    },
  },
  optimizeDeps: {
    include: ["monaco-editor", "@monaco-editor/react", "monaco-yaml"],
  },
});
