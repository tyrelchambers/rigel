// Installed-app detection — port of Sources/Helmsman/Catalog/InstallMatch.swift.
// Pure functions; recompute freely on every render to track the watch stream.

import type {
  CatalogApp,
  DeploymentLike,
  StatefulSetLike,
  PodLike,
} from "./types";
import type { InstalledImage } from "./updates";

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

/**
 * The `sha256:…` digest a container actually pulled, extracted from a pod
 * status `imageID`. Handles the common forms: `ghcr.io/x/y@sha256:…`,
 * `docker-pullable://x/y@sha256:…`, and a bare `sha256:…`. null when no digest
 * is embedded. Mirrors Swift `runningImageDigest`.
 */
export function runningImageDigest(imageID: string | undefined): string | null {
  if (!imageID) return null;
  const i = imageID.indexOf("sha256:");
  if (i === -1) return null;
  return imageID.slice(i);
}

/**
 * For each installed catalog app, the exact image reference it's running — the
 * full string (registry + repo + tag) of the first container that matched one
 * of the app's `matchImages`. This is what the update check needs: the running
 * *tag*, not just the repo path. Apps with no matching container are omitted.
 * Mirrors Swift `installedImages`.
 */
export function installedImages(
  apps: CatalogApp[],
  deployments: DeploymentLike[],
  statefulSets: StatefulSetLike[],
  pods: PodLike[],
): InstalledImage[] {
  // (normalized repo path, full image ref) for every running container.
  const running: Array<{ repo: string; full: string }> = [];
  const collect = (image: string | undefined) => {
    if (image) running.push({ repo: imageRepoPath(image), full: image });
  };
  for (const d of deployments)
    for (const c of d.spec?.template?.spec?.containers ?? []) collect(c.image);
  for (const s of statefulSets)
    for (const c of s.spec?.template?.spec?.containers ?? []) collect(c.image);
  for (const p of pods) for (const c of p.spec?.containers ?? []) collect(c.image);

  // (normalized repo path, running digest) from pod *status* — the only place
  // the actually-pulled sha lives. Match a pod's spec container to its status
  // by name so we attribute the digest to the right image.
  const podDigests: Array<{ repo: string; digest: string }> = [];
  for (const p of pods) {
    const idByName = new Map<string, string>();
    for (const cs of p.status?.containerStatuses ?? []) {
      if (cs.name && cs.imageID) idByName.set(cs.name, cs.imageID);
    }
    for (const c of p.spec?.containers ?? []) {
      const digest = c.name ? runningImageDigest(idByName.get(c.name)) : null;
      if (!c.image || !digest) continue;
      podDigests.push({ repo: imageRepoPath(c.image), digest });
    }
  }

  const out: InstalledImage[] = [];
  for (const app of apps) {
    for (const raw of app.matchImages) {
      const candidate = imageRepoPath(raw);
      const hit = running.find((r) => repoPathsMatch(r.repo, candidate));
      if (hit) {
        const digest = podDigests.find((d) => repoPathsMatch(d.repo, candidate))?.digest;
        out.push({
          appID: app.id,
          image: hit.full,
          repoURL: app.repoURL ?? undefined,
          runningDigest: digest,
        });
        break;
      }
    }
  }
  return out;
}
