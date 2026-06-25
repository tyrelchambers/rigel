// Build-time resolver for the latest desktop release. The download page bakes
// these asset URLs into static hrefs at `astro build`, so a published GitHub
// release must trigger a marketing rebuild (see marketing-build.yml).
//
// Asset-name contract (set in apps/desktop/electron-builder.yml, Workstream A):
//   mac    Rigel-<version>-<arch>.dmg      (arch: arm64 | x64)
//   win    Rigel-Setup-<version>.exe
//   linux  Rigel-<version>-<arch>.AppImage (arch token may be x86_64)
//          Rigel-<version>-<arch>.deb      (arch token may be amd64)
// We match by extension + arch token, never a hardcoded arch string, so the
// resolver survives electron-builder's per-target arch naming.

const REPO = "tyrelchambers/rigel";
export const RELEASES_URL = `https://github.com/${REPO}/releases`;
export const LATEST_RELEASE_URL = `${RELEASES_URL}/latest`;

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface GitHubRelease {
  tag_name?: string;
  html_url?: string;
  assets?: ReleaseAsset[];
}

export interface ResolvedAssets {
  macArm?: string;
  macIntel?: string;
  win?: string;
  linuxAppImage?: string;
  linuxDeb?: string;
}

export interface ResolvedRelease {
  /** The release version (e.g. "0.2.0"), or null when no release exists. */
  version: string | null;
  /** Link to the release's own page, or the releases list as a fallback. */
  url: string;
  assets: ResolvedAssets;
}

const ARM_TOKENS = ["arm64", "aarch64"];
const INTEL_TOKENS = ["x64", "x86_64", "amd64", "intel"];

function hasToken(name: string, tokens: string[]): boolean {
  const lower = name.toLowerCase();
  return tokens.some((t) => lower.includes(t));
}

/**
 * Pure mapper: GitHub release JSON → version + the five platform asset URLs,
 * matched by file extension and (where it matters) an arch token. Any slot with
 * no matching asset is left `undefined`.
 */
export function mapAssets(release: GitHubRelease): ResolvedRelease {
  const assets = release.assets ?? [];
  const find = (
    predicate: (asset: ReleaseAsset) => boolean,
  ): string | undefined => assets.find(predicate)?.browser_download_url;

  const isExt = (ext: string) => (a: ReleaseAsset) =>
    a.name.toLowerCase().endsWith(ext);

  const dmgs = assets.filter(isExt(".dmg"));
  // macOS: prefer an explicit arch token; if a build emits a single untagged
  // .dmg, treat it as Apple Silicon (the default target).
  const macArm =
    dmgs.find((a) => hasToken(a.name, ARM_TOKENS))?.browser_download_url ??
    (dmgs.length === 1 && !hasToken(dmgs[0].name, INTEL_TOKENS)
      ? dmgs[0].browser_download_url
      : undefined);
  const macIntel = dmgs.find((a) => hasToken(a.name, INTEL_TOKENS))
    ?.browser_download_url;

  const tag = release.tag_name ?? null;
  const version = tag ? tag.replace(/^v/, "") : null;

  return {
    version,
    url: release.html_url ?? LATEST_RELEASE_URL,
    assets: {
      macArm,
      macIntel,
      win: find(isExt(".exe")),
      linuxAppImage: find(isExt(".appimage")),
      linuxDeb: find(isExt(".deb")),
    },
  };
}

const FALLBACK: ResolvedRelease = {
  version: null,
  url: LATEST_RELEASE_URL,
  assets: {},
};

/**
 * Fetch the latest published release and resolve its assets. On ANY failure
 * (network error, non-200, no release yet) returns a safe fallback so the page
 * builds green with zero releases — every download link then points at the
 * GitHub releases page.
 */
export async function getLatestRelease(): Promise<ResolvedRelease> {
  const token = import.meta.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "rigel-marketing-build",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      { headers },
    );
    if (!res.ok) return FALLBACK;
    const json = (await res.json()) as GitHubRelease;
    return mapAssets(json);
  } catch {
    return FALLBACK;
  }
}
