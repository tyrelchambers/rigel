// Catalog image-pinning policy helpers — shared by the pinning guardrail test
// (catalog.test.ts) and the update-check CLI (checkCatalogUpdates.ts).
//
// Policy: every container image baked into a catalog manifest MUST be pinned to
// an immutable reference — a concrete version tag or an @sha256 digest. Rolling
// tags (`:latest`, `:stable`, `:main`, …) are forbidden because they make an
// install non-reproducible and silently drift between installs.

/**
 * Rolling/mutable tags that must never be pinned in a catalog manifest. A pin to
 * any of these points at a moving target rather than a fixed release.
 */
export const MUTABLE_TAGS = new Set([
  "latest",
  "stable",
  "nightly",
  "main",
  "master",
  "edge",
  "dev",
  "develop",
  "release",
  "lts",
  "canary",
]);

/**
 * Every container image reference (`image: <ref>`) in a manifest YAML string,
 * in document order. Matches the `image:` key used by Pod/Deployment/etc.
 * container specs; ignores surrounding quoting.
 */
export function manifestImages(manifest: string): string[] {
  const out: string[] = [];
  for (const m of manifest.matchAll(/image:\s*["']?([^\s"'\\]+)/g)) out.push(m[1]);
  return out;
}

/**
 * The tag portion of an image reference, or null when it carries no tag. A
 * digest (`@sha256:…`) is stripped first, so `repo@sha256:…` and `repo:tag@…`
 * both resolve their tag (or lack of one) correctly.
 */
export function imageTag(ref: string): string | null {
  const at = ref.indexOf("@");
  const s = at === -1 ? ref : ref.slice(0, at);
  const slash = s.lastIndexOf("/");
  const colon = slash === -1 ? s.indexOf(":") : s.indexOf(":", slash + 1);
  return colon === -1 ? null : s.slice(colon + 1);
}

/**
 * Why an image reference violates the pinning policy, or null when it's a valid
 * immutable pin. A digest pin always passes; an untagged or mutable-tagged
 * reference fails with a human-readable reason.
 */
export function unpinnedReason(ref: string): string | null {
  if (ref.includes("@sha256:")) return null; // digest pin is immutable
  const tag = imageTag(ref);
  if (tag === null) return "no tag (defaults to :latest)";
  if (MUTABLE_TAGS.has(tag.toLowerCase())) return `mutable tag ":${tag}"`;
  // A tag that names no version at all (`community`, `alpine`, an edition or
  // variant word) is as rolling as `:latest`. Every immutable release tag we
  // accept — semver, CalVer, a `sha-…`/`RELEASE.…` build tag — carries a digit;
  // a digitless tag does not pin a version.
  if (!/[0-9]/.test(tag)) return `version-less tag ":${tag}" (rolling)`;
  return null;
}
