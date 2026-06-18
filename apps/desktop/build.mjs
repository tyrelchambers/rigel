// Desktop build — three esbuild bundles, all written to dist/:
//
//   main.js     Electron main process (CJS; electron external)
//   preload.js  Electron preload (CJS; electron external)
//   server.mjs  the Helmsman Node server, re-bundled from apps/server/src/index.ts
//
// Why we re-bundle the server here (instead of forking apps/server's own bundle
// or its TypeScript via tsx):
//   • Electron's utilityProcess ESM loader does NOT activate tsx's loader hooks
//     (`--import tsx` is passed through but the extensionless TS imports still
//     ERR_MODULE_NOT_FOUND), so forking the .ts entry doesn't work under Electron.
//   • apps/server's own bundle is ESM and relies on esbuild's __require shim for
//     Node builtins (pulled in by `ws`); under Electron's utility ESM context
//     that shim throws "Dynamic require of 'events' is not supported".
// So we produce a desktop-OWNED server.mjs that injects a real createRequire-backed
// `require` via a banner (fixes the dynamic-require), keeps node-pty external (it's
// a native addon — can't be bundled, and a desktop dep makes it resolvable next to
// this bundle), and is a normal ESM module Electron's utility loader accepts.
// This does NOT modify apps/server (no source/build-script edits).
import { build } from "esbuild";

const electronBundles = build({
  entryPoints: ["src/main.ts", "src/preload.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron"],
  logLevel: "info",
});

const serverBundle = build({
  entryPoints: ["../server/src/index.ts"],
  outfile: "dist/server.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // node-pty is a native N-API addon — never bundle it. Resolved at runtime from
  // apps/desktop/node_modules/node-pty (declared as a desktop dependency at the
  // same version as the server's), so `import "node-pty"` resolves next to this file.
  external: ["node-pty"],
  // Give the ESM bundle a real CommonJS `require` so esbuild's interop shim can
  // load Node builtins (events/stream/etc. via `ws`) under Electron's utility
  // ESM loader, which otherwise rejects esbuild's default dynamic-require shim.
  banner: {
    js: "import { createRequire as __helmsmanCreateRequire } from 'node:module'; const require = __helmsmanCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});

// The chat permission hook. claudeBridge.ts registers a PreToolUse hook command
// `node --import tsx <import.meta.url>/../permissionHook.ts` — i.e. it expects a
// permissionHook.ts SIBLING of the running server bundle. We emit a self-contained
// bundle under the name the server hardcodes (.ts), so the hook resolves next to
// dist/server.mjs and live AI chat's mutation-gating works. (tsx passes already-
// valid JS through unchanged, so the .ts extension is fine.)
const permissionHookBundle = build({
  entryPoints: ["../server/src/permissionHook.ts"],
  outfile: "dist/permissionHook.ts",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  allowOverwrite: true,
  logLevel: "info",
});

await Promise.all([electronBundles, serverBundle, permissionHookBundle]);
