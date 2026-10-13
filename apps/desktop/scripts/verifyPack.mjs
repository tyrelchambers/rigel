#!/usr/bin/env node
// Asserts a packed (electron-builder --dir) app actually contains the pieces it
// forks at runtime. The three OS layouts differ, so the resources dir is found
// rather than assumed, and every check names what breaks when it fails.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname: on Windows the latter yields "/D:/a/..."
// with a leading slash, which is not a path any fs call accepts.
const RELEASE = fileURLToPath(new URL("../release/", import.meta.url));

/**
 * Every packed app, not just the first: the macOS job packs arm64 and x64, and
 * the x64 one is where a missing cross-arch native binding would show up.
 * macOS buries resources in the .app; Windows and Linux put them beside the
 * binary.
 */
function resourceDirs() {
  if (!existsSync(RELEASE)) fail(`no release/ directory — did electron-builder --dir run?`);
  const found = [];
  for (const entry of readdirSync(RELEASE)) {
    const dir = join(RELEASE, entry);
    if (!statSync(dir).isDirectory()) continue;
    const mac = join(dir, "Rigel.app", "Contents", "Resources");
    if (existsSync(mac)) found.push(mac);
    else if (existsSync(join(dir, "resources"))) found.push(join(dir, "resources"));
  }
  if (found.length === 0) {
    fail(`no packed app under ${RELEASE} (looked for */Rigel.app/Contents/Resources and */resources)`);
  }
  return found;
}

const problems = [];
function check(path, why) {
  if (!existsSync(path)) problems.push(`MISSING ${path}\n    → ${why}`);
}
function fail(msg) {
  console.error(`verifyPack: ${msg}`);
  process.exit(1);
}

for (const res of resourceDirs()) {
console.log(`verifyPack: checking ${res}`);

// The Node server the desktop forks, and the SPA it serves.
check(join(res, "server", "server-entry.mjs"), "main.ts forks this in a packaged app; without it the app has no backend");
check(join(res, "server", "server.mjs"), "the server bundle server-entry.mjs imports");
check(join(res, "server", "node_modules", "node-pty"), "terminals need the native addon on the real filesystem, never inside an asar");
check(join(res, "web", "dist", "index.html"), "WEB_DIST points here; without it the window loads nothing");
}

if (problems.length > 0) {
  console.error(`\nverifyPack: ${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("verifyPack: OK");
