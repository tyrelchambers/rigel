// Bundle the signups server to a single ESM file.
//
// The output is ESM (the server uses top-level `await`), but `pg` is CommonJS
// and dynamically `require()`s Node builtins (events/stream/…). esbuild's default
// ESM `__require` shim throws "Dynamic require of 'events' is not supported" at
// runtime, so we inject a real `createRequire`-backed `require` via a banner —
// the same fix the desktop server bundle uses. `pg-native` stays external (it's
// an optional native addon we don't use).
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/signups.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  external: ["pg-native"],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: "info",
});
