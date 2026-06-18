// Re-apply the execute bit to node-pty's `spawn-helper` prebuild.
//
// node-pty ships a `spawn-helper` binary that its UnixTerminal launches via
// posix_spawnp on macOS/Linux. pnpm extracts prebuild files from the tarball
// WITHOUT preserving the mode bits, so after a fresh `pnpm install` the helper
// lands as 0644 (no +x) and every `pty.spawn(...)` fails with
// "posix_spawnp failed." node-pty's own post-install only touches build/Release
// (the node-gyp path), never the prebuilds/ dir that's actually loaded — so we
// fix it here. Runs as apps/server's postinstall; a no-op on Windows.
import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

if (process.platform !== "win32") {
  try {
    const require = createRequire(import.meta.url);
    // Resolve node-pty's package root, then the platform prebuild's spawn-helper.
    const pkgRoot = dirname(require.resolve("node-pty/package.json"));
    const helper = join(
      pkgRoot,
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    );
    if (existsSync(helper)) {
      const mode = statSync(helper).mode;
      chmodSync(helper, mode | 0o111); // add owner/group/other execute
    }
  } catch (err) {
    // Best-effort: if node-pty isn't installed or the layout changed, do nothing
    // (the terminal panel will surface a clear error at spawn time instead).
    console.warn(`[fix-node-pty] skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}
