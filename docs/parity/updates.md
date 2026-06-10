# Update Detection Normative Specification

Port of `Sources/Helmsman/Updates/` (Swift) to web. Defines the exact behavior for detecting newer versions of installed catalog apps by querying container registries and GitHub Releases.

## Overview

The update system detects newer stable releases for installed apps in three deterministic tiers:

1. **Registry Tier**: Query a registry (Docker Hub / GHCR) for available tags and compare semver.
2. **Moving-Tag Tier**: For non-version tags (`:latest`, `:stable`), compare pulled digests.
3. **GitHub Releases Tier**: When the app has a `repoURL` pointing to GitHub, fetch the newest release tag.

Each tier returns a `UpdateStatus`: either a version upgrade available, up-to-date confirmation, or `null` (→ fallback to Claude when the network tiers can't decide).

---

## Data Structures

### ImageReference

Parsed container image reference split into queryable parts.

```typescript
interface ImageReference {
  /** Registry host, e.g. "docker.io", "ghcr.io". Defaults to "docker.io" when absent. */
  registry: string;
  /** Repository path (e.g. "library/nextcloud", "plausible/community-edition"). */
  repository: string;
  /** Running tag, or null when digest-only (e.g. "v2.1.4" or null). */
  tag: string | null;
}
```

**Parsing rules** (`parseImageRef(raw: string) → ImageReference | null`):
- Return null only for empty/whitespace input.
- Strip digest suffix (`@sha256:…`) first; digests are never compared for updates.
- Identify registry host: first path segment is a host iff it contains `.`, `:` (port), or is `localhost`. Else `docker.io`.
- Split tag off the remainder: the `:` after the last `/`. Colons before the last `/` are registry port.
- Normalize Docker Hub single-name official images: `nextcloud` → `library/nextcloud`.

**Examples**:
- `ghcr.io/plausible/community-edition:v2.1.4` → `{registry: "ghcr.io", repository: "plausible/community-edition", tag: "v2.1.4"}`
- `vaultwarden/server:latest` → `{registry: "docker.io", repository: "vaultwarden/server", tag: "latest"}`
- `nextcloud:29-apache` → `{registry: "docker.io", repository: "library/nextcloud", tag: "29-apache"}`
- `ghcr.io/x/y@sha256:abc…` → `{registry: "ghcr.io", repository: "x/y", tag: null}`

### ReleaseVersion

Parsed version from a container tag; only the numeric components matter for comparison.

```typescript
interface ReleaseVersion {
  components: number[];    // e.g. [3, 2, 1] for "v3.2.1"
  isPrerelease: boolean;   // true if tag contains rc/alpha/beta/pre/dev/snapshot/nightly/canary
}
```

**Parsing rules** (`parseReleaseVersion(tag: string) → ReleaseVersion | null`):
- Return null for empty tags or tags with no numeric components (e.g. `latest`, `stable`, `main`).
- Strip leading `v` (case-insensitive).
- Split numeric core (leading digits + dots) from suffix.
- Extract integer components: `1.22` → `[1, 22]`, `v15.1.0.147` → `[15, 1, 0, 147]`.
- Mark as prerelease if suffix starts with `rc`, `alpha`, `beta`, `pre`, `dev`, `snapshot`, `nightly`, or `canary` (after stripping `-_.`).
- Plain variant suffixes like `-alpine` or `_ce` are NOT prerelease; different flavors of the same stable version.

**Comparison** (`ReleaseVersion < ReleaseVersion`):
- Component-wise numeric; shorter-but-equal prefixes rank lower: `1.2 < 1.2.1`.
- Stable release outranks prerelease of same numbers: `3.0.0-rc.1 < 3.0.0`.
- Treat missing components as 0: `1.22 == 1.22.0` in numeric value, but `1.22 < 1.22.0` in strict ordering.

### UpdateStatus

Outcome of an update check for one app.

```typescript
type UpdateStatus =
  | { kind: "upToDate"; current: string }
  | { kind: "updateAvailable"; current: string; latest: string }
  | { kind: "unknown"; reason: string };
```

- `upToDate`: Running the newest stable tag we could find.
- `updateAvailable`: A newer stable tag exists; `latest` is the tag to upgrade to.
- `unknown`: Couldn't determine by tag (e.g. `:latest`-pinned, unknown registry, or network failure). Reason is for tooltips/debugging.

### InstalledImage

Describes a catalog app's running container instance.

```typescript
interface InstalledImage {
  appID: string;                      // Catalog app slug
  image: string;                      // Full running reference, e.g. "ghcr.io/x/y:v1.2.3"
  repoURL?: string;                   // App's GitHub repo (if any), used by Releases tier
  runningDigest?: string;             // sha256:… from pod status.imageID (for moving-tag tier)
}
```

---

## Resolver: Pure Functions

All resolver functions are **pure** and **testable without network**. Registry I/O is injected.

### `pickLatestVersion(tags: string[], currentTag: string) → string | null`

Given available tags and the running tag, pick the newest *stable* version strictly newer than `current`. Returns null if nothing is newer or the running tag is not a parseable version.

- Parse all tags into `ReleaseVersion` objects.
- Ignore pre-releases and non-version tags (`latest`, `stable`, etc.).
- Among tags newer than `current`, pick the newest. Trailing-zero tolerance: `1.23` matches `v1.23.0`.

**Example**:
- `current: "1.22"`, `tags: ["1.22", "1.23", "1.24", "v2.0.0-rc.1", "latest"]`
- Parsed: `1.22 [1,22]`, `1.23 [1,23]`, `1.24 [1,24]`, `v2.0.0-rc.1 [2,0,0 prerelease]`, `latest null`
- Newer stable: `1.24` is newest → return `"1.24"`

### `newestStableTag(tags: string[]) → string | null`

Find the newest *stable* version tag in a list. Used by the moving-tag tier where we have no running version to compare.

- Parse all tags into `ReleaseVersion`.
- Ignore pre-releases and non-version tags.
- Return the tag with the highest `ReleaseVersion` value, or null if none parse.

### `schemeComparable(a: ReleaseVersion, b: ReleaseVersion) → boolean`

Reject clearly-different version schemes (e.g., 8-digit date tags vs semver). Heuristic: leading numeric component's digit width must be within 1 of each other.

**Example**:
- `a = [20250609, ...]` (width 8), `b = [1, 2, 3]` (width 1) → `false`
- `a = [1, 22]` (width 1), `b = [2, 0]` (width 1) → `true`

### `canResolveByRegistry(image: string) → boolean`

Predicate: can this image be checked by tag list alone?

Returns false (route to fallback) for:
- `:latest`-pinned (moving tag, needs digest tier)
- Digest-only pins (no tag)
- Non-semver tags (tag does not parse as `ReleaseVersion`)
- Unknown registry (not Docker Hub or GHCR)

```typescript
function canResolveByRegistry(image: string): boolean {
  const ref = parseImageRef(image);
  if (!ref || !ref.tag || ref.tag === "latest") return false;
  if (!parseReleaseVersion(ref.tag)) return false;
  if (!registryIsKnown(ref.registry)) return false;
  return true;
}
```

---

## Registry Abstraction (Fetch-Injected)

All network I/O goes through a `TagSource` interface. Allows tests to inject a stub fetch without hitting the network.

```typescript
interface TagSource {
  listTags(repository: string): Promise<string[]>;
  resolveDigest?(repository: string, reference: string): Promise<string | null>;
}
```

### TagSourceFactory

Maps a registry host to a `TagSource`, or returns null for unknown registries (routed to Claude fallback).

```typescript
function tagSourceFor(registry: string): TagSource | null {
  switch (registry) {
    case "docker.io":
    case "registry-1.docker.io":
      return new DockerHubTagSource();
    case "ghcr.io":
      return new GHCRTagSource();
    default:
      return null;
  }
}
```

### DockerHubTagSource

Queries `hub.docker.com/v2/repositories/<repo>/tags` (public, no auth).

**`listTags(repository: string) → Promise<string[]>`**:
- GET `https://hub.docker.com/v2/repositories/{repository}/tags?page_size=100&ordering=last_updated`
- Parse JSON response: `{results: [{name: string}, …]}`
- Return the `name` array.

**`resolveDigest(repository: string, reference: string) → Promise<string | null>`**:
- Fetch an anonymous registry token from `https://auth.docker.io/token?service=registry.docker.io&scope=repository:{repository}:pull`
- HEAD request to `https://registry-1.docker.io/v2/{repository}/manifests/{reference}` with:
  - `Authorization: Bearer {token}`
  - `Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json`
- Return the `Docker-Content-Digest` response header (canonical manifest-list digest), or null on error.

### GHCRTagSource

Queries the OCI distribution API at `ghcr.io/v2/<repo>/tags/list` with **required pagination**.

**`listTags(repository: string) → Promise<string[]>`**:
- Fetch anonymous bearer token from `https://ghcr.io/token?scope=repository:{repository}:pull`
- Start with `next = https://ghcr.io/v2/{repository}/tags/list?n=100`
- Loop (up to 50 pages as a runaway guard):
  - GET `next` with `Authorization: Bearer {token}`
  - Parse JSON: `{tags: [string]}`
  - Accumulate tags into result array.
  - Extract `Link: rel="next"` header (regex: `<([^>]*)>; rel="next"`).
  - Resolve relative reference against `https://ghcr.io` base.
  - Continue until no next page.
- Return accumulated tags.

**Critical**: GHCR returns tags oldest-first with no ordering guarantee. The newest releases sit on the **last page**. Only fetching page 1 silently caps visibility at ~100 oldest tags, causing large images (e.g., paperless-ngx with 400+ tags) to appear perpetually up to date. **Must walk every page.**

**`resolveDigest(repository: string, reference: string) → Promise<string | null>`**:
- Same token fetch.
- HEAD request to `https://ghcr.io/v2/{repository}/manifests/{reference}` with auth + multi-arch Accept header.
- Return `Docker-Content-Digest` header or null.

### GitHubReleaseSource

Queries GitHub Releases API (no auth required; 60 req/hr-per-IP limit is ample for daily sweeps).

**`listTags(repository: string) → Promise<string[]>`**:
- GET `https://api.github.com/repos/{owner/repo}/releases/latest`
- Parse JSON: `{tag_name: string}`
- Return `[tag_name]` as a single-element array (so existing `newestStableUpgrade` comparison applies).

---

## Resolver: Update Detection Tiers

### Tier 1: Registry (Version Tags)

**`resolveViaRegistry(item: InstalledImage) → Promise<UpdateStatus | null>`**

For images with a semver tag on a known registry, compare against available tags.

Returns null (route to next tier) unless ALL of these are true:
- Image parses and has a tag.
- Tag is NOT `:latest` (moving tag → Tier 1.5).
- Tag parses as a `ReleaseVersion`.
- Registry is known (has a `TagSource`).

If all are true:
1. Fetch tags via `tagSource.listTags(repository)`.
2. Call `pickLatestVersion(tags, ref.tag)`.
3. Return `UpdateStatus`:
   - If `pickLatestVersion` returns a tag: `{kind: "updateAvailable", current: ref.tag, latest: tag}`.
   - Else: `{kind: "upToDate", current: ref.tag}`.

**Example**: `ghcr.io/plausible/community-edition:v2.1.4`
- Tag `v2.1.4` parses as `[2, 1, 4]` stable.
- Fetch tags from GHCR. If newer stable (e.g., `v2.2.0`) exists, return update available.

### Tier 1.5: Moving Tag (Digest Comparison)

**`resolveViaMovingTag(item: InstalledImage) → Promise<UpdateStatus | null>`**

For non-version tags (`:latest`, `:stable`) on a known registry, compare digests because the tag name tells us nothing.

Returns null unless:
- Image has a tag.
- Tag does NOT parse as a `ReleaseVersion` (moving tag, e.g., `:latest`).
- Registry is known.

If all are true:
1. Fetch tags via `tagSource.listTags(repository)`.
2. Call `newestStableTag(tags)` to find the newest released version.
3. Resolve its digest: `tagSource.resolveDigest(repository, newestTag)`.
4. Resolve the "current" digest:
   - Prefer `item.runningDigest` (from pod status, the actual pull).
   - Fall back to `tagSource.resolveDigest(repository, ref.tag)` (what `:latest` points to now in the registry).
5. Compare digests:
   - If equal: `{kind: "upToDate", current: ref.tag}` (the moving tag name, e.g., `latest`).
   - If different: `{kind: "updateAvailable", current: ref.tag, latest: newestTag}` (the concrete version to upgrade to).
6. Return null if any digest can't be obtained (prefer not to guess).

**Rationale**: A frozen/abandoned `:latest` (running an old build, or pointing at one) is correctly flagged as behind when its digest differs from the newest stable version's digest.

**Example**: `myrepo/app:latest` with `runningDigest: sha256:abc123…`
- Newest stable tag is `v2.0.0` with digest `sha256:def456…`.
- Digests differ → return `{kind: "updateAvailable", current: "latest", latest: "v2.0.0"}`.

### Tier 2: GitHub Releases

**`resolveViaReleases(item: InstalledImage) → Promise<UpdateStatus | null>`**

For apps with a GitHub repo, fetch the newest release tag and compare version schemes.

Returns null unless:
- `item.repoURL` exists and points to `github.com`.
- Can extract `owner/repo` from the URL (must have at least owner + repo path components).
- Have a `GitHubReleaseSource`.

If all are true:
1. Derive `owner/repo` from `repoURL` (strip trailing `.git` if present).
2. Fetch releases: `githubSource.listTags(ownerRepo)` → returns `[tag_name]`.
3. Call `statusFromRelease(currentImage, releaseTag)` (pure function, below).
4. Return the result or null if it returns nil (scheme mismatch, non-version tags, etc.).

### Pure: `statusFromRelease(currentImage: string, releaseTag: string) → UpdateStatus | null`

Compare a running image against a GitHub release tag (deterministic, no network).

Returns null (route to Claude fallback) if:
- Current image does not parse.
- Release tag does not parse as a `ReleaseVersion`.
- Current image tag is null or digest-only.
- Current tag does NOT parse as a `ReleaseVersion` (moving tag like `:latest` can't be compared to a release).
- Version schemes are not comparable (via `schemeComparable`).

Otherwise, return:
- If release is newer than current (via `isNewerRelease`): `{kind: "updateAvailable", current: currentTag, latest: releaseTag}`.
- Else: `{kind: "upToDate", current: currentTag}`.

**Strict-newer test** (`isNewerRelease(candidate, running) → boolean`):
- Tolerate trailing-zero formatting differences (normalize before comparing).
- `1.23` (running) vs `v1.23.0` (release) → same release, not newer.
- `1.23` (running) vs `v1.24.0` (release) → release is newer.

---

## Resolver Main Logic

### `resolve(item: InstalledImage) → Promise<UpdateStatus | null>`

Resolve one item deterministically through the tiers.

```typescript
async function resolveOne(item: InstalledImage): Promise<UpdateStatus | null> {
  if (const status = await resolveViaRegistry(item)) return status;
  if (const status = await resolveViaMovingTag(item)) return status;
  return await resolveViaReleases(item);
}
```

Returns null (caller routes to Claude fallback) only if all three tiers return null.

### `resolveBatch(items: InstalledImage[]) → Promise<{resolved: Map<appID, UpdateStatus>, needsAssist: InstalledImage[]}>`

Resolve a batch of installed apps.

```typescript
async function resolveBatch(items: InstalledImage[]): Promise<{
  resolved: Map<string, UpdateStatus>;
  needsAssist: InstalledImage[];
}> {
  const resolved = new Map<string, UpdateStatus>();
  const needsAssist: InstalledImage[] = [];
  
  for (const item of items) {
    const status = await resolveOne(item);
    if (status) {
      resolved.set(item.appID, status);
    } else {
      needsAssist.push(item);
    }
  }
  
  return { resolved, needsAssist };
}
```

---

## Server API Route

### `POST /api/updates`

Check one or more running container images for available updates.

**Request body**:
```typescript
interface UpdatesRequest {
  images: string[];  // Full image references, e.g. ["ghcr.io/x/y:v1.2.3"]
}
```

**Response**:
```typescript
interface UpdateResult {
  image: string;                                                  // Echoed input
  currentTag: string | null;                                      // Parsed tag from image (or null if digest-only)
  latest: string | null;                                          // New version to upgrade to (or null)
  updateAvailable: boolean;                                       // true iff a newer version exists
  kind: "version" | "digest" | "none" | "unknown";               // Tier that answered (or unknown if all tiers fail)
  reason?: string;                                                // For "unknown", explain why we couldn't determine
}

interface UpdatesResponse {
  results: UpdateResult[];
}
```

**Behavior**:
- For each image in the request:
  1. Parse as `ImageReference`.
  2. Resolve via `resolveOne` (all three tiers).
  3. Return the result mapped to the response shape.
  4. Network errors on a *per-image* basis return `{updateAvailable: false, kind: "unknown", reason: "…"}`. Never 500 the whole request.
- Request-level caching is fine (same request, no per-second polling).
- No persistent caching (client owns that via TanStack Query).

**Response shape mapping**:
- Tier 1 (version tag): `kind: "version"`, set `latest` and `updateAvailable`.
- Tier 1.5 (digest): `kind: "digest"`, set `latest` (concrete version) and `updateAvailable`.
- Tier 2 (releases): `kind: "version"` (same tier as registry), set `latest` and `updateAvailable`.
- Fallback unavailable: `kind: "unknown"`, `updateAvailable: false`, include `reason`.

**Examples**:

```json
{
  "results": [
    {
      "image": "ghcr.io/plausible/community-edition:v2.1.4",
      "currentTag": "v2.1.4",
      "latest": "v2.2.0",
      "updateAvailable": true,
      "kind": "version"
    },
    {
      "image": "myrepo/app:latest",
      "currentTag": "latest",
      "latest": "v3.0.0",
      "updateAvailable": true,
      "kind": "digest"
    },
    {
      "image": "postgres:16-alpine",
      "currentTag": "16-alpine",
      "latest": null,
      "updateAvailable": false,
      "kind": "version"
    },
    {
      "image": "ghcr.io/unknown-registry/x:v1.0",
      "currentTag": "v1.0",
      "latest": null,
      "updateAvailable": false,
      "kind": "unknown",
      "reason": "registry not supported"
    }
  ]
}
```

---

## Installed-App Detection Integration

The web already has `installedAppIDs` and `imageRepoPath` in `packages/catalog/src/detection.ts` (ported from Swift).

When the update check needs the running images for installed apps:

1. Get the catalog apps from `packages/catalog/src/loader.ts`.
2. Get live deployments, statefulsets, pods from the cluster cache (or WebSocket).
3. Call `installedImages(apps, deployments, statefulsets, pods)` to get `[InstalledImage]`.

New export in `packages/catalog/src/detection.ts`:

```typescript
interface InstalledImage {
  appID: string;
  image: string;
  repoURL?: string;
  runningDigest?: string;
}

/**
 * For each installed catalog app, the exact image reference it's running.
 * Mirrors Swift `installedImages`.
 */
export function installedImages(
  apps: CatalogApp[],
  deployments: DeploymentLike[],
  statefulSets: StatefulSetLike[],
  pods: PodLike[],
): InstalledImage[] {
  // ...
}
```

Also export `runningImageDigest(imageID: string | undefined) → string | null` to extract the `sha256:…` from pod status `imageID`.

---

## Web Panel Integration: Catalog Update Badges

Wire update results into the existing Catalog panel.

### Query: `/api/updates`

In the Catalog detail view or card, when displaying an installed app:

1. Fetch running images for the app via `installedImages(...)`.
2. POST to `/api/updates` with those images.
3. Cache via TanStack Query with a reasonable TTL (e.g., 10 min within a session).
4. On the card/detail view, display the status:
   - **Update available**: Badge `"current → latest"` with an "Update" button → hand off to Claude for the upgrade action.
   - **Up to date**: Badge `"up to date"` with a checkmark.
   - **Unknown**: Badge `"version unknown"` with a question mark + tooltip explaining why.
   - **Not checked yet**: `"not checked"` (no results in cache).

### Card Badge Rendering

Display a small, inline badge showing the update status for each installed app in the grid:

```
┌─────────────────────────────┐
│ Icon  App Name              │  <- existing card header
│                             │
│ [installed] [category] CPU  │  <- existing chip row
│                             │
│ ↑ v1.0 → v2.0 | ⟲ [Update] │  <- NEW status row (installed only)
└─────────────────────────────┘
```

States for installed apps:
- `pending` (queued in an active check): Gray spinner + "queued"
- `checking` (in-flight lookup): Spinner + "checking for updates…"
- `checked` → results:
  - ✓ `updateAvailable` → `"↑ <current> → <latest>"` (orange/pending color) + [Update] button
  - ✓ `upToDate` → `"✓ up to date"` (green/running color)
  - ✓ `unknown` → `"? version unknown"` (gray) + tooltip with `reason`
  - `nil` → `"not checked"`

Reuse existing badge styling (shadcn + Tailwind) from the Swift implementation's status pills.

### Update Button Action

When the user clicks [Update], hand off to Claude:

```action
{
  "kind": "setImage",
  "name": "<app-name>",
  "namespace": "<namespace>",
  "container": "<container-name>",
  "image": "<new-image-ref-with-new-tag>"
}
```

---

## Edge Cases & Error Handling

1. **Empty tag list from registry**: Treat as "no update available" (up to date).
2. **Registry connection timeout/5xx**: Per-image, return `{updateAvailable: false, kind: "unknown", reason: "registry unavailable"}`.
3. **Malformed response from registry**: Same — per-image, don't crash the whole request.
4. **Digest resolution unavailable**: Some registries don't support digest endpoints (e.g., GitHub Releases); return null from `resolveDigest` → tier returns nil → next tier tries.
5. **Moving tag with no running digest**: Can't compare without knowing what was actually pulled; prefer not to guess (return null). If the tag resolved to in the registry now differs from what the pod status says, we can't know if it's actually updated without the pod's original pull digest.
6. **Pre-releases in a tag list**: Ignore (`isPrerelease: true`). Never recommend a pre-release as an upgrade.
7. **Non-semver tags** (e.g., `latest-alpine`, `15.1.0.147-custom`): If they don't parse as a `ReleaseVersion`, they're treated as non-version and ignored in version-comparison tiers. They may still be detected in the moving-tag tier if used as a tag.

---

## Testing (TDD)

### Image Parsing (`parseImageRef`)

- Empty / whitespace → null.
- Registry detection: `.`, `:port`, `localhost`, vs. plain words.
- Digest stripping.
- Tag extraction: `:` after last `/` only.
- Docker Hub official normalization: `nextcloud` → `library/nextcloud`.

**Test cases**:
```
parseImageRef("")                                      → null
parseImageRef("nextcloud")                            → {registry: "docker.io", repository: "library/nextcloud", tag: null}
parseImageRef("nextcloud:29-apache")                  → {registry: "docker.io", repository: "library/nextcloud", tag: "29-apache"}
parseImageRef("docker.io/nextcloud:29-apache")       → {registry: "docker.io", repository: "nextcloud", tag: "29-apache"}
parseImageRef("ghcr.io/plausible/ce:v2.1.4")         → {registry: "ghcr.io", repository: "plausible/ce", tag: "v2.1.4"}
parseImageRef("localhost:5000/myapp:v1@sha256:abc")  → {registry: "localhost:5000", repository: "myapp", tag: "v1"}
```

### Version Parsing & Comparison (`parseReleaseVersion`, `<`)

- Non-version tags → null: `latest`, `stable`, `main`, `1-alpine` (no leading numeric).
- `v` prefix stripped.
- Prerelease detection: `v1.0.0-rc.1` is prerelease, `1.0.0-alpine` is not.
- Component-wise numeric: `1.22 < 1.100`.
- Shorter ranked lower: `1.2 < 1.2.1`.
- Stable > prerelease: `3.0.0 > 3.0.0-rc.1`.

**Test cases**:
```
parseReleaseVersion("latest")      → null
parseReleaseVersion("v1.2.3")      → {components: [1, 2, 3], isPrerelease: false}
parseReleaseVersion("1-alpine")    → null (leading non-digit)
parseReleaseVersion("15.1.0.147")  → {components: [15, 1, 0, 147], isPrerelease: false}
parseReleaseVersion("v2.0.0-rc.1") → {components: [2, 0, 0], isPrerelease: true}

v([1,22]) < v([1,100])             → true
v([1,2]) < v([1,2,1])              → true
v([3,0,0], pre) < v([3,0,0])       → true
```

### Version Picking (`pickLatestVersion`)

- Ignore pre-releases and non-version tags.
- Find newest newer than running.
- Trailing-zero tolerance: `1.23 == 1.23.0` in value.

**Test cases**:
```
pickLatestVersion("1.22", ["1.22", "1.23", "1.24", "v2.0.0-rc.1", "latest"])
  → "1.24"

pickLatestVersion("1.24", ["1.22", "1.23", "1.24"])
  → null (nothing newer)

pickLatestVersion("1.23", ["1.23.0", "1.23.1", "latest-alpine"])
  → "1.23.1" (ignores non-version, treats 1.23.0 as same)
```

### Moving-Tag Digest Tier (Mocked Fetch)

Inject a mock `TagSource` that returns canned tag lists and digests.

```typescript
class MockTagSource implements TagSource {
  async listTags(): Promise<string[]> {
    return ["v1.0.0", "v1.1.0", "v2.0.0"];
  }
  async resolveDigest(repo: string, ref: string): Promise<string | null> {
    const digests: Record<string, string> = {
      "v2.0.0": "sha256:new",
      "latest": "sha256:old",
    };
    return digests[ref] || null;
  }
}

// Inject into resolver
resolver.tagSourceFor = (host) => new MockTagSource();

// Test: :latest with old digest vs new stable version
const item: InstalledImage = {
  appID: "app1",
  image: "myrepo/app:latest",
  runningDigest: "sha256:old",
};
const status = await resolveViaMovingTag(item);
expect(status).toEqual({
  kind: "updateAvailable",
  current: "latest",
  latest: "v2.0.0",
});
```

### GHCR Pagination (Mocked Fetch)

Mock the HTTP responses including the `Link: rel="next"` header.

```typescript
// Simulate GHCR paginated response
const mockFetch = async (url: string): Promise<Response> => {
  if (url.includes("n=100")) {
    return new Response(JSON.stringify({ tags: ["tag1", "tag2"] }), {
      headers: {
        "Link": '<https://ghcr.io/v2/repo/tags/list?n=100&last=tag2>; rel="next"',
      },
    });
  }
  if (url.includes("last=tag2")) {
    return new Response(JSON.stringify({ tags: ["tag3", "tag4"] }), {
      headers: { /* no next */ },
    });
  }
  return new Response("", { status: 404 });
};

// Inject and test
const source = new GHCRTagSource({ fetch: mockFetch });
const tags = await source.listTags("repo");
expect(tags).toEqual(["tag1", "tag2", "tag3", "tag4"]);
```

### `canResolveByRegistry` Predicate

```
canResolveByRegistry("ghcr.io/x/y:v1.2.3")  → true
canResolveByRegistry("ghcr.io/x/y:latest")  → false (moving tag)
canResolveByRegistry("ghcr.io/x/y@sha256")  → false (digest-only)
canResolveByRegistry("unknown.io/x/y:v1.0") → false (unknown registry)
canResolveByRegistry("x/y:latest-alpine")   → false (non-version tag)
```

---

## Acceptance Criteria

The implementation is complete when:

1. ✅ **Image ref parsing**: `parseImageRef` handles all documented cases (registry detection, digest stripping, tag extraction, Docker Hub normalization).

2. ✅ **Version parsing & comparison**: `parseReleaseVersion` recognizes version tags vs non-version, prerelease detection, `ReleaseVersion` comparison is strict and correct (component-wise, prerelease < stable).

3. ✅ **Version picking**: `pickLatestVersion` returns the newest stable tag newer than running, ignoring pre-releases. `newestStableTag` returns the newest stable. Trailing-zero tolerance works.

4. ✅ **Resolver tiers**: All three tiers work in sequence. Tier 1 queries registry and compares versions. Tier 1.5 compares digests for moving tags (`:latest`, `:stable`). Tier 2 queries GitHub Releases. Each returns `null` when it can't answer.

5. ✅ **Registry abstraction with injected fetch**: `TagSource` interface is injectable. `DockerHubTagSource` queries hub.docker.com. `GHCRTagSource` queries GHCR with **mandatory pagination** via Link header following. `GitHubReleaseSource` queries GitHub API.

6. ✅ **GHCR pagination**: Full tag list even for >100-tag images. Link header parsing and `rel="next"` following works correctly. Page cap (50) prevents runaway loops.

7. ✅ **Server route POST /api/updates**: Accepts array of image refs. Returns per-image results with `kind` (version/digest/unknown), `updateAvailable`, `latest`, `currentTag`. Network failures per-image return `{updateAvailable: false, kind: "unknown"}` without 500ing. Request-level caching OK.

8. ✅ **Installed-app detection**: `installedImages(...)` exported from `packages/catalog/src/detection.ts`. Integrates with catalog app loading and cluster resources.

9. ✅ **Catalog panel wiring**: Update badges on installed-app cards show status (up to date / update available → version / unknown). "Update" button hands off to Claude with a `setImage` action. Status row reuses existing badge styling.

10. ✅ **TDD**: All pure resolver functions tested without network (mocked `TagSource`). Mocked GHCR responses test pagination. Image parsing, version picking, predicate tests pass.

11. ✅ **All tests pass**: `pnpm --filter @helmsman/catalog test`, `pnpm --filter @helmsman/server test`, `pnpm --filter web test`, `pnpm --filter web typecheck && build`.

12. ✅ **Existing routes intact**: No breaking changes to `/api/health`, `/api/metrics/*`, `/api/action`, `/api/apply`, `/api/helm`, `/ws`.

