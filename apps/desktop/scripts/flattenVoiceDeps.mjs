#!/usr/bin/env node
/**
 * Builds a flat, self-contained node_modules for the voice worker, one per
 * platform/arch this OS packages, under dist/voice-deps/<target>/.
 *
 * The worker bundle keeps @livekit/rtc-node and @livekit/local-inference
 * external (native N-API addons cannot be bundled), and @livekit/agents
 * resolves the latter with createRequire(import.meta.url) — so resolution
 * walks up from wherever voice.mjs ships, never from cwd. A packaged app must
 * therefore have a real node_modules directory beside voice.mjs.
 *
 * pnpm's store cannot be copied as-is: apps/desktop/node_modules/@livekit/*
 * are symlinks into .pnpm/<id>/node_modules/, where the packages they require
 * are SIBLINGS. Copy one and its requires break. Flattening reconstructs a
 * layout Node can resolve, which is safe here because no two packages in the
 * closure need different versions of anything.
 */
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** Node's platform name for an electron-builder-style target prefix. */
const NODE_PLATFORM = { mac: "darwin", win: "win32", linux: "linux" };

/** What this OS packages. macOS ships both arches from one runner. */
export function targetsFor(platform = process.platform) {
  if (platform === "darwin") {
    return [
      { dir: "mac-arm64", os: "darwin", cpu: "arm64" },
      { dir: "mac-x64", os: "darwin", cpu: "x64" },
    ];
  }
  if (platform === "win32") return [{ dir: "win-x64", os: "win32", cpu: "x64" }];
  return [{ dir: "linux-x64", os: "linux", cpu: "x64" }];
}

/**
 * Whether a package may be installed for a target. Packages with no os/cpu
 * constraints are portable and always included; the platform sub-packages
 * carry both and are the whole reason this filter exists. `libc` matters on
 * Linux, where the gnu and musl builds are separate packages.
 */
export function matchesTarget(pkg, target) {
  const listed = (field) => (Array.isArray(pkg[field]) ? pkg[field] : null);
  const os = listed("os");
  if (os && !os.includes(target.os)) return false;
  const cpu = listed("cpu");
  if (cpu && !cpu.includes(target.cpu)) return false;
  const libc = listed("libc");
  if (libc && target.os === "linux" && !libc.includes("glibc")) return false;
  return true;
}

/**
 * Resolve a dependency by walking up the filesystem from the depender's REAL
 * path, exactly as Node does. Deliberately not require.resolve: several of
 * these packages expose only "." in their exports map, so resolving
 * `<name>/package.json` throws on precisely the ones that matter.
 */
function resolveFrom(fromDir, name) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function readPkg(dir) {
  return JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
}

/** Every package the worker needs at runtime for one target, name → real dir. */
export async function closureFor(rootNames, fromDir, target) {
  const found = new Map();
  const queue = [];
  for (const name of rootNames) {
    const dir = resolveFrom(fromDir, name);
    if (!dir) throw new Error(`cannot resolve ${name} from ${fromDir} — is it a dependency of apps/desktop?`);
    queue.push([name, dir]);
  }
  while (queue.length > 0) {
    const [name, dir] = queue.shift();
    if (found.has(name)) continue;
    const pkg = await readPkg(dir);
    // An optional dep for another platform is not missing, it is irrelevant.
    if (!matchesTarget(pkg, target)) continue;
    found.set(name, dir);
    const deps = { ...pkg.dependencies, ...pkg.optionalDependencies };
    for (const dep of Object.keys(deps)) {
      if (found.has(dep)) continue;
      const depDir = resolveFrom(dir, dep);
      // Optional platform packages for other targets are simply absent from
      // the store; a missing REQUIRED dep is caught by the assertion below.
      if (depDir) queue.push([dep, depDir]);
    }
  }
  return found;
}

/**
 * Sourcemaps only. An earlier version also dropped `src/`, which broke
 * @datastructures-js/deque — it ships its RUNTIME from src/, and the failure
 * surfaces as "Cannot find module './src/deque'" at worker startup rather
 * than at build time. Guessing which directories a package needs is not worth
 * the megabytes; maps are the bulk of the waste anyway.
 */
function skip(src) {
  return src.endsWith(".map");
}

/** The bindings a usable tree must contain, and what their absence costs. */
const REQUIRED_BINDINGS = [
  ["@livekit/rtc-ffi-bindings-", "the worker cannot open a LiveKit room"],
  ["@livekit/local-inference-", "the VAD silently degrades to a no-op instead of failing"],
];

export function missingBindings(names) {
  return REQUIRED_BINDINGS.filter(([prefix]) => !names.some((n) => n.startsWith(prefix)));
}

/**
 * A tree with no binding is the failure worth shouting about: @livekit's
 * loaders fall back rather than throw, so local-inference silently degrades
 * the VAD to a no-op and end-of-turn prediction quietly becomes always-true.
 *
 * Strictness is deliberately asymmetric. The target matching THIS machine is
 * always required — a developer whose own build cannot run voice wants to know
 * now. A cross-arch target (the x64 tree built on an arm64 mac) is skipped
 * with a warning locally, because pnpm only fetches other arches on a clean
 * install and failing every local build over it would be hostile. Under CI,
 * where installs are always clean, nothing is optional.
 */
function bindingsVerdict(found, target, { strict, native }) {
  const missing = missingBindings([...found.keys()]);
  if (missing.length === 0) return "ok";
  const detail = missing.map(([prefix, why]) => `no ${prefix}* — ${why}`).join("; ");
  const where = `${target.dir} (${target.os}/${target.cpu})`;
  if (strict || native) {
    throw new Error(
      `${where}: ${detail}.\n` +
        `  pnpm installs only the platform packages matching the running machine, and\n` +
        `  supportedArchitectures (pnpm-workspace.yaml) applies to a CLEAN install only.\n` +
        `  Reinstall from scratch to get the other arch locally.`,
    );
  }
  console.warn(`  voice deps: skipping ${where} — ${detail} (cross-arch packages need a clean install)`);
  return "skipped";
}

export async function flattenVoiceDeps({
  fromDir = new URL("..", import.meta.url).pathname,
  outDir = new URL("../dist/voice-deps", import.meta.url).pathname,
  roots = ["@livekit/rtc-node", "@livekit/local-inference"],
  platform = process.platform,
} = {}) {
  await rm(outDir, { recursive: true, force: true });
  const results = [];
  for (const target of targetsFor(platform)) {
    const found = await closureFor(roots, fromDir, target);
    const native = target.os === platform && target.cpu === process.arch;
    if (bindingsVerdict(found, target, { strict: Boolean(process.env.CI), native }) === "skipped") continue;
    for (const [name, dir] of found) {
      const dest = join(outDir, target.dir, "node_modules", ...name.split("/"));
      await mkdir(dirname(dest), { recursive: true });
      // dereference: pnpm hands us symlinks, and an app bundle must not carry
      // links pointing outside itself.
      await cp(dir, dest, { recursive: true, dereference: true, filter: (src) => !skip(src) });
    }
    results.push({ target: target.dir, packages: found.size });
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = await flattenVoiceDeps();
  for (const r of results) console.log(`  voice deps → dist/voice-deps/${r.target} (${r.packages} packages)`);
}
