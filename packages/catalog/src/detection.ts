// Installed-app detection — port of Sources/Helmsman/Catalog/InstallMatch.swift.
// Pure functions; recompute freely on every render to track the watch stream.

import type {
  CatalogApp,
  DeploymentLike,
  StatefulSetLike,
  PodLike,
} from "./types";

/**
 * Normalize a container image reference down to its repo path — the part that
 * identifies *what* the image is, independent of where it's pulled from or
 * which version is pinned. Drops any `@sha256:…` digest and the `:tag`, keeping
 * the registry host (if present) and the path.
 *
 *   "docker.io/vaultwarden/server:latest" -> "docker.io/vaultwarden/server"
 *   "ghcr.io/plausible/community-edition:v2.1.4" -> "ghcr.io/plausible/community-edition"
 *   "nextcloud:29-apache" -> "nextcloud"
 *
 * Mirrors Swift `imageRepoPath`.
 */
export function imageRepoPath(image: string): string {
  let s = image;
  // Drop a digest suffix first: everything from `@` onward.
  const at = s.indexOf("@");
  if (at !== -1) s = s.slice(0, at);
  // Drop the tag. The tag separator is the `:` that follows the last `/`
  // (a `:` before the last `/` is a registry host port, not a tag).
  const slash = s.lastIndexOf("/");
  if (slash !== -1) {
    const afterSlash = slash + 1;
    const colon = s.indexOf(":", afterSlash);
    if (colon !== -1) s = s.slice(0, colon);
  } else {
    const colon = s.indexOf(":");
    if (colon !== -1) s = s.slice(0, colon);
  }
  return s;
}

/**
 * Canonicalize a repo path for matching: drop a leading registry-host segment
 * (the first segment when it looks like a host — contains a `.`/`:` or is
 * `localhost`) and a leading Docker Hub `library/`. So `docker.io/library/
 * nextcloud`, `library/nextcloud`, and `nextcloud` all canonicalize equal.
 *
 * Mirrors Swift `canonicalRepoPath`.
 */
function canonicalRepoPath(path: string): string {
  let p = path;
  const slash = p.indexOf("/");
  if (slash !== -1) {
    const first = p.slice(0, slash);
    if (first === "localhost" || first.includes(".") || first.includes(":")) {
      p = p.slice(slash + 1);
    }
  }
  if (p.startsWith("library/")) p = p.slice("library/".length);
  return p;
}

/**
 * True when `running` (a normalized repo path) refers to the same image as
 * `candidate`. Compares the canonical repo path on both sides, so only a
 * differing/absent *registry host* (or `library/`) is tolerated — NOT a
 * differing org/namespace segment. Mirrors Swift `repoPathsMatch`.
 */
export function repoPathsMatch(running: string, candidate: string): boolean {
  return canonicalRepoPath(running) === canonicalRepoPath(candidate);
}

/**
 * Set of catalog-app `id`s whose `matchImages` are found running in the
 * cluster. Scans container images across Deployments, StatefulSets, and loose
 * Pods. Pure — no side effects; recompute freely so the result tracks the watch
 * stream. Matching is host- and tag-insensitive. Mirrors Swift `installedAppIDs`.
 */
export function installedAppIDs(
  apps: CatalogApp[],
  deployments: DeploymentLike[],
  statefulSets: StatefulSetLike[],
  pods: PodLike[],
): Set<string> {
  const runningRepos = new Set<string>();
  for (const d of deployments) {
    for (const c of d.spec?.template?.spec?.containers ?? []) {
      if (c.image) runningRepos.add(imageRepoPath(c.image));
    }
  }
  for (const s of statefulSets) {
    for (const c of s.spec?.template?.spec?.containers ?? []) {
      if (c.image) runningRepos.add(imageRepoPath(c.image));
    }
  }
  for (const p of pods) {
    for (const c of p.spec?.containers ?? []) {
      if (c.image) runningRepos.add(imageRepoPath(c.image));
    }
  }

  const installed = new Set<string>();
  for (const app of apps) {
    const isInstalled = app.matchImages.some((raw) => {
      const candidate = imageRepoPath(raw);
      for (const running of runningRepos) {
        if (repoPathsMatch(running, candidate)) return true;
      }
      return false;
    });
    if (isInstalled) installed.add(app.id);
  }
  return installed;
}
