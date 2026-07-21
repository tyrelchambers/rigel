// Bundles the rigel-audit CLI to a single self-contained ESM file (@rigel/k8s
// inlined via the tsconfig paths alias). Shared by `pnpm --filter @rigel/audit-cli
// build` (standalone + desktop) and the agent image's Docker build, so the banner
// fix lives in ONE place.
//
// The banner injects a real `require` (createRequire). esbuild's ESM output uses a
// `__require` shim that delegates to `require` when it exists and otherwise throws
// `Dynamic require of "process" is not supported`; some bundled CJS deps (yaml)
// call require() for Node builtins, so without this the bundle dies at load.
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(root, "src/index.ts")],
  outfile: join(root, "dist/rigel-audit.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  tsconfig: join(root, "tsconfig.json"),
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
});
