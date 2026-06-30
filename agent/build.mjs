// Agent build — esbuild bundles the three runtime entrypoints to dist/:
//
//   index.js         the always-on remediation agent (image CMD)
//   fixRunner.js     the one-shot fix-PR Job entry (the Job overrides command to run this)
//   guardedKubectl.js  the read-only kubectl/helm shim the non-Claude bridges exec
//                      (RIGEL_AGENT_GUARD_CMD points here)
//
// Why esbuild (not raw `tsc`): the agent now consumes `@rigel/k8s` BY SOURCE via
// the tsconfig "paths" alias (../packages/k8s/src), and `rootDir: ..` makes a
// plain tsc emit land outside dist/. esbuild bundles each entry into a single
// self-contained ESM file with `@rigel/k8s` INLINED (resolved via the same
// tsconfig paths), keeping only Node builtins external — so the runtime image
// needs no node_modules for the agent itself (the model CLIs stay global).
// Mirrors apps/desktop/build.mjs (which re-bundles apps/server the same way).
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Honor tsconfig "paths" so `@rigel/k8s/src/*` resolves to ../packages/k8s/src/*.
  tsconfig: "tsconfig.json",
  // Give the ESM bundle a real CommonJS `require` so esbuild's interop shim can
  // load Node builtins under Node's ESM loader (mirrors the desktop server bundle).
  banner: {
    js: "import { createRequire as __rigelCreateRequire } from 'node:module'; const require = __rigelCreateRequire(import.meta.url);",
  },
  logLevel: "info",
};

await Promise.all([
  build({ ...common, entryPoints: ["src/index.ts"], outfile: "dist/index.js" }),
  build({ ...common, entryPoints: ["src/fixRunner.ts"], outfile: "dist/fixRunner.js" }),
  build({ ...common, entryPoints: ["src/guardedKubectl.ts"], outfile: "dist/guardedKubectl.js" }),
]);
