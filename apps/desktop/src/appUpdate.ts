/**
 * Desktop self-update check. The app knows its own version (`app.getVersion()`);
 * this compares it against the latest published GitHub release and reports
 * whether a newer one exists. It never auto-installs (that needs a signed build
 * + electron-updater) — the UI chip just points the user at the download page.
 *
 * Every failure path resolves to `updateAvailable: false` so a network blip or a
 * rate-limited API never surfaces a false "update" or throws into the IPC layer.
 */

const REPO = "tyrelchambers/rigel";

/** Where the update chip sends the user to get the new build. */
export const DOWNLOAD_URL = "https://rigel.run/download";

/** The GitHub release-notes page for a version tag. */
export function releaseUrlFor(version: string): string {
  return `https://github.com/${REPO}/releases/tag/v${version.replace(/^v/, "")}`;
}

export interface AppUpdateInfo {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string | null;
  downloadUrl: string;
  /** Release-notes page for the latest version, when known. */
  releaseUrl: string | null;
}

/** Compare two dotted numeric versions. >0 if a is newer, <0 if older, 0 equal.
 *  Tolerates a leading `v` and ignores any prerelease/build suffix. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/, "")
      .split(/[-+]/)[0]
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export function isNewer(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}

export async function checkForUpdate(
  currentVersion: string,
  fetchFn: typeof fetch = fetch,
): Promise<AppUpdateInfo> {
  const base: AppUpdateInfo = {
    updateAvailable: false,
    currentVersion,
    latestVersion: null,
    downloadUrl: DOWNLOAD_URL,
    releaseUrl: null,
  };
  try {
    const res = await fetchFn(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      { headers: { Accept: "application/vnd.github+json", "User-Agent": "rigel-desktop" } },
    );
    if (!res.ok) return base;
    const json = (await res.json()) as { tag_name?: string; html_url?: string };
    if (!json.tag_name) return base;
    const latestVersion = json.tag_name.replace(/^v/, "");
    return {
      updateAvailable: isNewer(latestVersion, currentVersion),
      currentVersion,
      latestVersion,
      downloadUrl: DOWNLOAD_URL,
      releaseUrl: json.html_url ?? null,
    };
  } catch {
    return base;
  }
}
