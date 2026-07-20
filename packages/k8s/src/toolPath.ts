import { existsSync, realpathSync } from "node:fs";
import { dirname, join, win32 as winPath, posix as posixPath } from "node:path";

interface SdkBinDeps {
  pathEnv?: string;
  exists?: (p: string) => boolean;
  realpath?: (p: string) => string;
}

let cachedSdkBin: string | undefined;

/**
 * Dir of the REAL gcloud binary (following symlinks). Homebrew installs
 * component binaries (gke-gcloud-auth-plugin) here but doesn't symlink them
 * onto PATH — so PATH-based lookups miss them even after
 * `gcloud components install gke-gcloud-auth-plugin`.
 *
 * Strategy: find `gcloud` on PATH, resolve symlinks, return its dirname.
 * e.g. `/opt/homebrew/bin/gcloud` → realpath → `/opt/homebrew/share/google-cloud-sdk/bin/gcloud`
 *      → dirname → `/opt/homebrew/share/google-cloud-sdk/bin`
 *
 * Result is memoized on success (survives gcloud upgrades because realpath
 * re-resolves the current target; only the cached *dir* is stable per process).
 */
export function gcloudSdkBin(deps: SdkBinDeps = {}): string | null {
  if (cachedSdkBin !== undefined) return cachedSdkBin;
  const pathEnv = deps.pathEnv ?? process.env.PATH ?? "";
  const exists = deps.exists ?? existsSync;
  const realpath = deps.realpath ?? realpathSync;
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, "gcloud");
    if (exists(candidate)) {
      try {
        cachedSdkBin = dirname(realpath(candidate));
        return cachedSdkBin;
      } catch {
        /* keep scanning — broken symlink, permission error, etc. */
      }
    }
  }
  return null; // not found — don't cache so a later install is picked up
}

/** For tests: reset the memo so each test starts clean. */
export function __resetGcloudSdkBinCache(): void {
  cachedSdkBin = undefined;
}

interface OnPathDeps {
  pathEnv?: string;
  pathExt?: string;
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
}

/**
 * True when `bin` resolves to a file on PATH. Cross-platform: splits PATH on the
 * OS-correct delimiter (`;` on Windows, `:` elsewhere) and, on Windows, tries each
 * PATHEXT extension so `.exe`/`.cmd`/`.bat` shims are found. Existence-only (no
 * exec-bit probe) — enough to answer "is this CLI installed?" without spawning it
 * (which sidesteps the Windows `.cmd` spawn pitfalls). Deps are injectable for tests.
 */
export function commandOnPath(bin: string, deps: OnPathDeps = {}): boolean {
  const pathEnv = deps.pathEnv ?? process.env.PATH ?? "";
  if (!pathEnv) return false;
  const platform = deps.platform ?? process.platform;
  const exists = deps.exists ?? existsSync;
  const isWin = platform === "win32";
  const delim = isWin ? ";" : ":";
  // Build paths with the OS-correct separator even when `platform` is injected on a
  // different host (so this works in tests and in real cross-platform use).
  const joinPath = isWin ? winPath.join : posixPath.join;
  const exts = isWin
    ? (deps.pathExt ?? process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  for (const dir of pathEnv.split(delim)) {
    if (!dir) continue;
    for (const ext of exts) {
      if (exists(joinPath(dir, bin + ext))) return true;
    }
  }
  return false;
}

/**
 * Returns a copy of `base` env with the gcloud SDK bin directory prepended to
 * PATH so that component-installed tools (e.g. gke-gcloud-auth-plugin) are
 * visible to child processes. Idempotent — the dir is only prepended once even
 * if called multiple times with the same base.
 */
export function spawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const dir = gcloudSdkBin();
  const path = base.PATH ?? "";
  if (!dir || path.split(":").includes(dir)) return base;
  // Guard against a base with no PATH: `${dir}:` would leave a trailing empty
  // segment, which POSIX interprets as "search the current directory".
  return { ...base, PATH: path ? `${dir}:${path}` : dir };
}
