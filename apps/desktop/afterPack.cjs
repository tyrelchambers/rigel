// electron-builder afterPack hook.
//
// node-pty spawns a tiny `spawn-helper` binary to fork the PTY's login shell on
// macOS/Linux. It MUST be executable. electron-builder usually preserves file
// modes when copying extraResources, but node-pty's x64 prebuild ships WITHOUT
// the +x bit (only the arm64 spawn-helper is pre-marked executable), so we chmod
// every spawn-helper under the packed app's Resources to 0o755 defensively. This
// runs once per packed arch (context.appOutDir is that arch's output dir).
const { promises: fs } = require("node:fs");
const path = require("node:path");

/** Recursively find files named `spawn-helper` under `dir`. */
async function findSpawnHelpers(dir) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await findSpawnHelpers(full)));
    } else if (e.isFile() && e.name === "spawn-helper") {
      out.push(full);
    }
  }
  return out;
}

exports.default = async function afterPack(context) {
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const resourcesDir = path.join(context.appOutDir, appName, "Contents", "Resources");
  const helpers = await findSpawnHelpers(resourcesDir);
  for (const h of helpers) {
    await fs.chmod(h, 0o755);
    console.log(`[afterPack] chmod +x ${path.relative(context.appOutDir, h)}`);
  }
  if (helpers.length === 0) {
    console.warn("[afterPack] WARNING: no node-pty spawn-helper found under Resources");
  }
};
