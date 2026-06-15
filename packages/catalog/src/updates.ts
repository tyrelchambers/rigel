// Update detection — port of Sources/Helmsman/Updates/ (Swift) to TypeScript.
//
// Detects newer stable releases for installed catalog apps via three
// deterministic tiers:
//   1. Registry (version tags)  — query a registry, compare semver.
//   2. Moving-tag (digests)     — :latest/:stable → compare pulled digests.
//   3. GitHub Releases          — repoURL on github.com → newest release tag.
//
// Every pure function here is testable without network: registry I/O is
// injected behind the `TagSource` interface. Mirrors the Swift originals
// exactly (same parsing rules, comparison ordering, and tier sequencing).

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

/**
 * A container image reference split into the parts an update check needs.
 * The digest, if any, is dropped — update checks compare tags, not digests.
 * Mirrors Swift `ImageReference`.
 */
export interface ImageReference {
  /** Registry host, e.g. "docker.io", "ghcr.io". Defaults to "docker.io". */
  registry: string;
  /** Repository path within the registry (Docker Hub officials get "library/"). */
  repository: string;
  /** Running tag, or null when the reference pins a digest only. */
  tag: string | null;
}

/**
 * A parsed, comparable version extracted from a container image tag. Only the
 * numeric components and the prerelease flag matter for comparison.
 * Mirrors Swift `ReleaseVersion`.
 */
export interface ReleaseVersion {
  components: number[];
  isPrerelease: boolean;
}

/** Outcome of an update check for one app. Mirrors Swift `UpdateStatus`. */
export type UpdateStatus =
  | { kind: "upToDate"; current: string }
  | { kind: "updateAvailable"; current: string; latest: string }
  | { kind: "unknown"; reason: string };

/**
 * One unit of update work: an installed catalog app paired with the exact
 * image reference it's running. Mirrors Swift `InstalledImage`.
 */
export interface InstalledImage {
  appID: string;
  /** Full running reference, e.g. "ghcr.io/plausible/community-edition:v2.1.4". */
  image: string;
  /** The app's source repo (GitHub Releases tier). */
  repoURL?: string;
  /** sha256:… the running pod actually pulled (moving-tag tier). */
  runningDigest?: string;
}

// ---------------------------------------------------------------------------
// parseImageRef — Swift `ImageReference.init?`
// ---------------------------------------------------------------------------

/**
 * Parse a raw image string from a running container spec. Returns null only for
 * an empty/whitespace string. Mirrors Swift `ImageReference.init?`.
 */
export function parseImageRef(raw: string): ImageReference | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // Strip a digest (`@sha256:…`) first; we never compare digests.
  let s = trimmed;
  const at = s.indexOf("@");
  if (at !== -1) s = s.slice(0, at);

  // Split off the registry host. The first path segment is a host iff it
  // contains a `.` or `:` (a port), or is exactly "localhost".
  let host = "docker.io";
  let remainder = s;
  const firstSlash = s.indexOf("/");
  if (firstSlash !== -1) {
    const first = s.slice(0, firstSlash);
    if (first === "localhost" || first.includes(".") || first.includes(":")) {
      host = first;
      remainder = s.slice(firstSlash + 1);
    }
  }

  // Split the tag off the remainder: the `:` after the last `/`.
  let repo = remainder;
  let parsedTag: string | null = null;
  const lastSlash = remainder.lastIndexOf("/");
  if (lastSlash !== -1) {
    const colon = remainder.indexOf(":", lastSlash + 1);
    if (colon !== -1) {
      repo = remainder.slice(0, colon);
      parsedTag = remainder.slice(colon + 1);
    }
  } else {
    const colon = remainder.indexOf(":");
    if (colon !== -1) {
      repo = remainder.slice(0, colon);
      parsedTag = remainder.slice(colon + 1);
    }
  }

  // Docker Hub official images ("nextcloud", "postgres") live under `library/`.
  if (host === "docker.io" && !repo.includes("/")) {
    repo = "library/" + repo;
  }

  return {
    registry: host,
    repository: repo,
    tag: parsedTag && parsedTag.length > 0 ? parsedTag : null,
  };
}

// ---------------------------------------------------------------------------
// parseReleaseVersion + comparison — Swift `ReleaseVersion`
// ---------------------------------------------------------------------------

/** Pre-release markers recognized after the numeric part. */
const PRERELEASE_MARKERS = [
  "rc",
  "alpha",
  "beta",
  "pre",
  "dev",
  "snapshot",
  "nightly",
  "canary",
];

/**
 * Parse a tag into a `ReleaseVersion`, or null when the tag carries no usable
 * numeric version (`latest`, `stable`, `main`, empty). Mirrors Swift
 * `ReleaseVersion.init?(tag:)`.
 */
export function parseReleaseVersion(tag: string): ReleaseVersion | null {
  let s = tag.trim().toLowerCase();
  if (s.length === 0) return null;
  if (s.startsWith("v")) s = s.slice(1);

  // Separate the numeric core (leading run of digits/dots) from the suffix.
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if ((ch >= "0" && ch <= "9") || ch === ".") i++;
    else break;
  }
  const core = s.slice(0, i);
  const suffix = s.slice(i);

  const parts = core
    .split(".")
    .filter((p) => p.length > 0)
    .map((p) => Number(p))
    .filter((n) => Number.isInteger(n));
  if (parts.length === 0) return null;

  // Prerelease iff the (delimiter-stripped) suffix names a known marker. A
  // plain variant suffix like `-alpine` or `_ce` is NOT a prerelease.
  const lowerSuffix = stripEdges(suffix, "-_.");
  const isPrerelease = PRERELEASE_MARKERS.some((m) => lowerSuffix.startsWith(m));

  return { components: parts, isPrerelease };
}

/** Trim a set of characters from both ends of a string (like Swift trimming). */
function stripEdges(s: string, chars: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && chars.includes(s[start])) start++;
  while (end > start && chars.includes(s[end - 1])) end--;
  return s.slice(start, end);
}

/**
 * Strict `<` ordering for `ReleaseVersion`. Component-wise numeric; a
 * pre-release ranks below the matching stable; fewer components ranks lower
 * when otherwise equal. Mirrors Swift `ReleaseVersion.<`.
 */
export function versionLess(lhs: ReleaseVersion, rhs: ReleaseVersion): boolean {
  const count = Math.max(lhs.components.length, rhs.components.length);
  for (let i = 0; i < count; i++) {
    const l = i < lhs.components.length ? lhs.components[i] : 0;
    const r = i < rhs.components.length ? rhs.components[i] : 0;
    if (l !== r) return l < r;
  }
  // Equal numbers: a pre-release is older than the matching stable.
  if (lhs.isPrerelease !== rhs.isPrerelease) return lhs.isPrerelease;
  // Fully equal numbers + same prerelease flag: fewer components ranks lower.
  return lhs.components.length < rhs.components.length;
}

// ---------------------------------------------------------------------------
// Tag picking — Swift `newestStableTag` / `newestStableUpgrade`
// ---------------------------------------------------------------------------

/**
 * The newest *stable* version tag in a registry's tag list, ignoring
 * pre-releases and unparseable tags (`latest`, `stable`, …). Mirrors Swift
 * `newestStableTag`. Null when no tag parses.
 */
export function newestStableTag(availableTags: string[]): string | null {
  let best: { tag: string; version: ReleaseVersion } | null = null;
  for (const tag of availableTags) {
    const v = parseReleaseVersion(tag);
    if (!v || v.isPrerelease) continue;
    if (best === null || versionLess(best.version, v)) best = { tag, version: v };
  }
  return best?.tag ?? null;
}

/**
 * The non-numeric "flavor" suffix of a tag — the arch / OS / edition / build
 * text that trails the numeric core, normalized (leading `-_.` stripped,
 * lowercased). Two tags share a flavor when this matches:
 *
 *   "v2.33.8" -> ""        "v2.34.2-amd64" -> "amd64"
 *   "16-alpine" -> "alpine"  "26.6.0.1-community" -> "community"
 *
 * Used to keep the registry tier from "upgrading" across flavors (a multi-arch
 * `:v2` pin must not jump to an arch-specific `:v3-amd64`, an `-alpine` pin must
 * not jump to a `-bookworm`, the community edition must not jump to enterprise).
 */
export function tagFlavor(tag: string): string {
  let s = tag.trim().toLowerCase();
  if (s.startsWith("v")) s = s.slice(1);
  let i = 0;
  while (i < s.length && ((s[i] >= "0" && s[i] <= "9") || s[i] === ".")) i++;
  return stripEdges(s.slice(i), "-_.");
}

/**
 * Whether `candidateTag` is a plausible same-scheme upgrade of `currentTag` —
 * not merely a string that parses as a higher version. Rejects the tags that
 * make a naive registry scan lie: arch/OS/edition/build flavors that differ
 * from what's running, date/epoch tags, bare CI integers, and trailing build
 * components. Both versions are assumed already parsed from their tags.
 */
function isComparableUpgrade(
  candidateTag: string,
  candidate: ReleaseVersion,
  currentTag: string,
  current: ReleaseVersion,
): boolean {
  // Same arch/OS/edition/build flavor as the running tag.
  if (tagFlavor(candidateTag) !== tagFlavor(currentTag)) return false;
  // Comparable numeric scheme — rejects date/epoch tags (e.g. "2026061506")
  // whose leading component is far wider than a semver major.
  if (!schemeComparable(candidate, current)) return false;
  // Not fewer components than what's running carries significantly — rejects a
  // bare CI integer ("39") standing in for a 3-part semver ("4.123.0"), while a
  // genuine `.0` patch ("2.2.0" vs "2.1.4") keeps its raw component count.
  const curSig = trimmedTrailingZeros(current.components).length;
  if (candidate.components.length < curSig) return false;
  // Not deeper than a full semver unless the running tag is already that deep —
  // rejects a 4-part build tag ("0.62.1.7") against a 3-part release ("0.62.1"),
  // while still allowing a partial pin to gain a patch ("1.23" -> "1.23.1").
  if (candidate.components.length > Math.max(current.components.length, 3)) {
    return false;
  }
  return true;
}

/**
 * Given the running tag and every tag a registry reports, find the newest
 * *stable* release strictly newer than what's running, ignoring tags whose
 * scheme/flavor isn't a comparable upgrade (see `isComparableUpgrade`). Null
 * when nothing is newer (or the running tag isn't a parseable version). Exposed
 * under the spec name `pickLatestVersion`.
 */
export function pickLatestVersion(
  availableTags: string[],
  currentTag: string,
): string | null {
  const current = parseReleaseVersion(currentTag);
  if (!current) return null;

  let best: { tag: string; version: ReleaseVersion } | null = null;
  for (const tag of availableTags) {
    const v = parseReleaseVersion(tag);
    if (!v || v.isPrerelease) continue;
    if (!versionLess(current, v)) continue;
    if (!isComparableUpgrade(tag, v, currentTag, current)) continue;
    if (best === null || versionLess(best.version, v)) best = { tag, version: v };
  }
  return best?.tag ?? null;
}

// ---------------------------------------------------------------------------
// Pure release-comparison helpers — Swift `UpdateResolver` statics
// ---------------------------------------------------------------------------

/** Pure: decide status from a known tag list. Mirrors Swift `statusFromTags`. */
export function statusFromTags(current: string, tags: string[]): UpdateStatus {
  const latest = pickLatestVersion(tags, current);
  if (latest !== null) {
    return { kind: "updateAvailable", current, latest };
  }
  return { kind: "upToDate", current };
}

/**
 * Reject clearly-different version schemes (e.g. an 8-digit date tag vs a
 * 1–2-digit semver major). The leading numeric component's digit width must be
 * within 1 of each other. Mirrors Swift `schemesComparable`.
 */
export function schemeComparable(a: ReleaseVersion, b: ReleaseVersion): boolean {
  const wa = String(a.components[0]).length;
  const wb = String(b.components[0]).length;
  return Math.abs(wa - wb) <= 1;
}

/** Drop pure trailing-zero components (keeping at least one). */
function trimmedTrailingZeros(components: number[]): number[] {
  const c = components.slice();
  while (c.length > 1 && c[c.length - 1] === 0) c.pop();
  return c;
}

/**
 * Strictly-newer test that tolerates pure trailing-zero formatting differences
 * (a running `1.23` is the same release as GitHub's `v1.23.0`). Mirrors Swift
 * `isNewerRelease`.
 */
export function isNewerRelease(
  candidate: ReleaseVersion,
  running: ReleaseVersion,
): boolean {
  const a = trimmedTrailingZeros(running.components);
  const b = trimmedTrailingZeros(candidate.components);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const l = i < a.length ? a[i] : 0;
    const r = i < b.length ? b[i] : 0;
    if (l !== r) return r > l;
  }
  return false;
}

/**
 * Decide update status from a running image and the newest GitHub release tag.
 * Returns null to mean "not trustworthy — fall through to Claude". Mirrors
 * Swift `statusFromRelease`.
 */
export function statusFromRelease(
  currentImage: string,
  releaseTag: string,
): UpdateStatus | null {
  const ref = parseImageRef(currentImage);
  if (!ref) return null;
  const releaseVer = parseReleaseVersion(releaseTag);
  if (!releaseVer) return null;

  const tag = ref.tag;
  if (!tag) return null; // digest-only → Claude

  // A moving tag (`:latest`, `:stable`) carries no version, so a release tag
  // alone can't tell us whether it's current — resolved by the moving-tag tier.
  const runningVer = parseReleaseVersion(tag);
  if (!runningVer) return null;
  if (!schemeComparable(runningVer, releaseVer)) return null;

  if (isNewerRelease(releaseVer, runningVer)) {
    return { kind: "updateAvailable", current: tag, latest: releaseTag };
  }
  return { kind: "upToDate", current: tag };
}

/**
 * Derive "owner/repo" from a GitHub repo URL, or null when the path doesn't
 * carry at least an owner and repo. Strips a trailing `.git`. Mirrors Swift
 * `ownerRepo(from:)`.
 */
export function ownerRepo(repoURL: string): string | null {
  let url: URL;
  try {
    url = new URL(repoURL);
  } catch {
    return null;
  }
  const parts = url.pathname.split("/").filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  let repo = parts[1];
  if (repo.endsWith(".git")) repo = repo.slice(0, -4);
  return `${parts[0]}/${repo}`;
}

// ---------------------------------------------------------------------------
// TagSource abstraction (fetch-injected)
// ---------------------------------------------------------------------------

/**
 * Fetches the list of available tags for one repository from a registry, and
 * optionally resolves a tag/reference to its manifest digest. Kept behind an
 * interface so the resolver can be unit-tested with a stub. Mirrors Swift
 * `TagSource`.
 */
export interface TagSource {
  listTags(repository: string): Promise<string[]>;
  /**
   * The manifest digest a tag currently resolves to (`Docker-Content-Digest`).
   * Optional: a source that can't resolve digests (e.g. GitHub Releases) routes
   * moving-tag images to assist rather than guessing.
   */
  resolveDigest?(repository: string, reference: string): Promise<string | null>;
}

/** Injectable fetch, matching the global `fetch` signature. */
export type FetchLike = typeof fetch;

/**
 * Accept header advertising the manifest media types a digest HEAD may return,
 * so multi-arch (OCI index / Docker manifest list) and single-arch images both
 * resolve to their canonical `Docker-Content-Digest`.
 */
const OCI_MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/**
 * Docker Hub: `GET hub.docker.com/v2/repositories/<repo>/tags`. Public, no auth.
 * Digests come from the OCI distribution API on `registry-1.docker.io` with an
 * anonymous pull token. Mirrors Swift `DockerHubTagSource`.
 */
export class DockerHubTagSource implements TagSource {
  private readonly fetch: FetchLike;

  constructor(opts: { fetch?: FetchLike } = {}) {
    this.fetch = opts.fetch ?? fetch;
  }

  async listTags(repository: string): Promise<string[]> {
    const url = `https://hub.docker.com/v2/repositories/${repository}/tags?page_size=100&ordering=last_updated`;
    const res = await this.fetch(url);
    if (!res.ok) throw new Error(`registry returned HTTP ${res.status}`);
    const body = (await res.json()) as { results?: Array<{ name: string }> };
    if (!body || !Array.isArray(body.results)) {
      throw new Error("could not decode registry tag list");
    }
    return body.results.map((r) => r.name);
  }

  async resolveDigest(
    repository: string,
    reference: string,
  ): Promise<string | null> {
    const token = await this.fetchRegistryToken(repository);
    const res = await this.fetch(
      `https://registry-1.docker.io/v2/${repository}/manifests/${reference}`,
      {
        method: "HEAD",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: OCI_MANIFEST_ACCEPT,
        },
      },
    );
    if (!res.ok) throw new Error(`registry returned HTTP ${res.status}`);
    return res.headers.get("Docker-Content-Digest");
  }

  private async fetchRegistryToken(repository: string): Promise<string> {
    const res = await this.fetch(
      `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`,
    );
    if (!res.ok) throw new Error(`registry returned HTTP ${res.status}`);
    const body = (await res.json()) as { token?: string };
    if (!body || typeof body.token !== "string") {
      throw new Error("could not decode registry token");
    }
    return body.token;
  }
}

/**
 * GHCR (OCI distribution API). Public images still require an anonymous bearer
 * token. The tag list is paginated and returned oldest-first, so the newest
 * releases sit on the LAST page — we MUST walk every page via the
 * `Link: rel="next"` header. Page cap (50) is a runaway-loop guard. Mirrors
 * Swift `GHCRTagSource`.
 */
export class GHCRTagSource implements TagSource {
  private readonly fetch: FetchLike;

  constructor(opts: { fetch?: FetchLike } = {}) {
    this.fetch = opts.fetch ?? fetch;
  }

  async listTags(repository: string): Promise<string[]> {
    const token = await this.fetchAnonymousToken(repository);
    const base = "https://ghcr.io";
    let next: string | null = `${base}/v2/${repository}/tags/list?n=100`;
    const all: string[] = [];
    let pages = 0;
    while (next !== null && pages < 50) {
      const res: Response = await this.fetch(next, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`registry returned HTTP ${res.status}`);
      const tags = GHCRTagSource.parseTags(await res.text());
      if (tags === null) throw new Error("could not decode registry tag list");
      all.push(...tags);
      next = GHCRTagSource.nextPageURL(res.headers.get("Link"), base);
      pages++;
    }
    return all;
  }

  /** Decode the `{ "tags": [...] }` body of one tag-list page. Null on malformed JSON. */
  static parseTags(body: string): string[] | null {
    try {
      const parsed = JSON.parse(body) as { tags?: string[] | null };
      return parsed.tags ?? [];
    } catch {
      return null;
    }
  }

  /**
   * Resolve the `rel="next"` page from an OCI `Link` response header against
   * `base`, or null when there is no next page. The registry emits a relative
   * reference like `</v2/<repo>/tags/list?last=X&n=100>; rel="next"`.
   */
  static nextPageURL(linkHeader: string | null, base: string): string | null {
    if (!linkHeader) return null;
    for (const segment of linkHeader.split(",")) {
      const part = segment.trim();
      if (!/rel="?next"?/.test(part)) continue;
      const lo = part.indexOf("<");
      const hi = part.indexOf(">");
      if (lo === -1 || hi === -1 || lo >= hi) continue;
      const reference = part.slice(lo + 1, hi);
      try {
        return new URL(reference, base).toString();
      } catch {
        return null;
      }
    }
    return null;
  }

  async resolveDigest(
    repository: string,
    reference: string,
  ): Promise<string | null> {
    const token = await this.fetchAnonymousToken(repository);
    const res = await this.fetch(
      `https://ghcr.io/v2/${repository}/manifests/${reference}`,
      {
        method: "HEAD",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: OCI_MANIFEST_ACCEPT,
        },
      },
    );
    if (!res.ok) throw new Error(`registry returned HTTP ${res.status}`);
    return res.headers.get("Docker-Content-Digest");
  }

  private async fetchAnonymousToken(repository: string): Promise<string> {
    const res = await this.fetch(
      `https://ghcr.io/token?scope=repository:${repository}:pull`,
    );
    if (!res.ok) throw new Error(`registry returned HTTP ${res.status}`);
    const body = (await res.json()) as { token?: string };
    if (!body || typeof body.token !== "string") {
      throw new Error("could not decode registry token");
    }
    return body.token;
  }
}

/**
 * GitHub Releases. `GET api.github.com/repos/<owner>/<repo>/releases/latest`
 * returns the newest release excluding drafts and prereleases, surfaced as a
 * single-element tag list so `pickLatestVersion`/`statusFromRelease` apply.
 * Mirrors Swift `GitHubReleaseSource`.
 */
export class GitHubReleaseSource implements TagSource {
  private readonly fetch: FetchLike;

  constructor(opts: { fetch?: FetchLike } = {}) {
    this.fetch = opts.fetch ?? fetch;
  }

  /** `repository` is `"owner/repo"` (derived from the app's repoURL). */
  async listTags(repository: string): Promise<string[]> {
    const res = await this.fetch(
      `https://api.github.com/repos/${repository}/releases/latest`,
      { headers: { Accept: "application/vnd.github+json" } },
    );
    if (!res.ok) throw new Error(`registry returned HTTP ${res.status}`);
    const body = (await res.json()) as { tag_name?: string };
    if (!body || typeof body.tag_name !== "string") {
      throw new Error("could not decode release");
    }
    return [body.tag_name];
  }
}

/**
 * Maps a registry host to a `TagSource`, or null for unknown registries (routed
 * to the Claude fallback). Mirrors Swift `TagSourceFactory.make`.
 */
export function tagSourceFor(
  registry: string,
  opts: { fetch?: FetchLike } = {},
): TagSource | null {
  switch (registry) {
    case "docker.io":
    case "registry-1.docker.io":
    case "index.docker.io":
      return new DockerHubTagSource(opts);
    case "ghcr.io":
      return new GHCRTagSource(opts);
    default:
      return null;
  }
}

/** True when a registry host has a `TagSource`. */
export function registryIsKnown(registry: string): boolean {
  return tagSourceFor(registry) !== null;
}

// ---------------------------------------------------------------------------
// Resolver — Swift `UpdateResolver`
// ---------------------------------------------------------------------------

export interface ResolverOptions {
  /** Maps a registry host to a tag source. Defaults to the real factory. */
  tagSourceFor?: (registry: string) => TagSource | null;
  /** Source for the GitHub Releases tier. Defaults to the real source. */
  githubSource?: TagSource | null;
}

/**
 * Resolves update status by querying registries. Stateless apart from the
 * injected sources, which keep the resolver unit-testable with stubs and no
 * network. Mirrors Swift `UpdateResolver`.
 */
export class UpdateResolver {
  private readonly tagSourceFor: (registry: string) => TagSource | null;
  private readonly githubSource: TagSource | null;

  constructor(opts: ResolverOptions = {}) {
    this.tagSourceFor = opts.tagSourceFor ?? ((r) => tagSourceFor(r));
    this.githubSource =
      opts.githubSource !== undefined ? opts.githubSource : new GitHubReleaseSource();
  }

  /**
   * Whether an image can even be checked by tag. `:latest`-pinned, digest-only,
   * non-semver, or unknown-registry images cannot. Mirrors Swift
   * `canResolveByRegistry`.
   */
  canResolveByRegistry(image: string): boolean {
    const ref = parseImageRef(image);
    if (!ref || !ref.tag || ref.tag === "latest") return false;
    if (!parseReleaseVersion(ref.tag)) return false;
    if (!this.tagSourceFor(ref.registry)) return false;
    return true;
  }

  /**
   * Resolve a single image deterministically. Tries the registry (version tag),
   * then the moving-tag digest tier, then the GitHub Releases tier. Null means
   * "needs assist" — the caller routes to the Claude fallback. Mirrors Swift
   * `resolveOne`.
   */
  async resolveOne(item: InstalledImage): Promise<UpdateStatus | null> {
    const viaRegistry = await this.resolveViaRegistry(item);
    if (viaRegistry) return viaRegistry;
    const viaMoving = await this.resolveViaMovingTag(item);
    if (viaMoving) return viaMoving;
    return this.resolveViaReleases(item);
  }

  /** Tier 1: tag-checkable image on a known registry. Mirrors `resolveViaRegistry`. */
  async resolveViaRegistry(item: InstalledImage): Promise<UpdateStatus | null> {
    const ref = parseImageRef(item.image);
    if (!ref || !ref.tag || ref.tag === "latest") return null;
    if (!parseReleaseVersion(ref.tag)) return null;
    const source = this.tagSourceFor(ref.registry);
    if (!source) return null;
    try {
      const tags = await source.listTags(ref.repository);
      return statusFromTags(ref.tag, tags);
    } catch {
      return null;
    }
  }

  /**
   * Tier 1.5: a moving tag (`:latest`, `:stable`) on a registry we can query.
   * The tag name tells us nothing, so we compare digests: what we're actually
   * running vs the newest released artifact. Mirrors `resolveViaMovingTag`.
   */
  async resolveViaMovingTag(item: InstalledImage): Promise<UpdateStatus | null> {
    const ref = parseImageRef(item.image);
    if (!ref || !ref.tag) return null;
    if (parseReleaseVersion(ref.tag)) return null; // not a moving tag
    const source = this.tagSourceFor(ref.registry);
    if (!source || !source.resolveDigest) return null;

    let newestTag: string;
    let newestDigest: string | null;
    try {
      const t = newestStableTag(await source.listTags(ref.repository));
      if (t === null) return null;
      newestTag = t;
      newestDigest = await source.resolveDigest(ref.repository, t);
    } catch {
      return null;
    }
    if (newestDigest === null) return null;

    // Prefer the digest the pod actually pulled; else what the moving tag
    // currently points to in the registry.
    let current: string | null | undefined = item.runningDigest;
    if (current == null) {
      try {
        current = await source.resolveDigest(ref.repository, ref.tag);
      } catch {
        current = null;
      }
    }
    if (current == null) return null;

    return current === newestDigest
      ? { kind: "upToDate", current: ref.tag }
      : { kind: "updateAvailable", current: ref.tag, latest: newestTag };
  }

  /**
   * Tier 2: newest GitHub release for the app's repo, when the version schemes
   * are comparable. Mirrors `resolveViaReleases`.
   */
  async resolveViaReleases(item: InstalledImage): Promise<UpdateStatus | null> {
    if (!item.repoURL || !this.githubSource) return null;
    let host: string;
    try {
      host = new URL(item.repoURL).host;
    } catch {
      return null;
    }
    if (host !== "github.com") return null;
    const repo = ownerRepo(item.repoURL);
    if (!repo) return null;

    let releaseTag: string;
    try {
      const tags = await this.githubSource.listTags(repo);
      if (tags.length === 0) return null;
      releaseTag = tags[0];
    } catch {
      return null;
    }
    return statusFromRelease(item.image, releaseTag);
  }

  /**
   * Resolve every item we can. Returns resolved statuses keyed by appID, plus
   * the items that need the Claude fallback. Mirrors Swift `resolve`.
   */
  async resolveBatch(
    items: InstalledImage[],
  ): Promise<{ resolved: Map<string, UpdateStatus>; needsAssist: InstalledImage[] }> {
    const resolved = new Map<string, UpdateStatus>();
    const needsAssist: InstalledImage[] = [];
    for (const item of items) {
      const status = await this.resolveOne(item);
      if (status) resolved.set(item.appID, status);
      else needsAssist.push(item);
    }
    return { resolved, needsAssist };
  }
}
