// Installed-app detection — port of Sources/Rigel/Catalog/InstallMatch.swift.
// Pure functions; recompute freely on every render to track the watch stream.

import type {
  CatalogApp,
  DeploymentLike,
  StatefulSetLike,
  DaemonSetLike,
  PodLike,
} from "./types";
import { boundAppID, boundContainer } from "./types";
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
 * Set of catalog-app `id`s installed in the cluster. Two passes, annotation
 * first:
 *
 *   1. Annotation pass (definitive). Any Deployment/StatefulSet/DaemonSet
 *      carrying `rigel.dev/catalog-app=<id>` IS that app's install,
 *      regardless of image. (A value for an unknown id is added verbatim; it
 *      just doesn't correspond to any card — no crash.)
 *   2. Image pass (fallback). For apps not already matched, match `matchImages`
 *      against running repo paths across Deployments/StatefulSets/DaemonSets/
 *      Pods (host- and tag-insensitive), exactly as before.
 *
 * Pure — recompute freely so the result tracks the watch stream. Mirrors Swift
 * `installedAppIDs`.
 */
export function installedAppIDs(
  apps: CatalogApp[],
  deployments: DeploymentLike[],
  statefulSets: StatefulSetLike[],
  daemonSets: DaemonSetLike[],
  pods: PodLike[],
): Set<string> {
  const installed = new Set<string>();

  // 1. Annotation pass — definitive, image not consulted.
  for (const w of [...deployments, ...statefulSets, ...daemonSets]) {
    const id = boundAppID(w.metadata);
    if (id) installed.add(id);
  }

  // 2. Image pass — fallback for apps not bound by annotation.
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
  for (const ds of daemonSets) {
    for (const c of ds.spec?.template?.spec?.containers ?? []) {
      if (c.image) runningRepos.add(imageRepoPath(c.image));
    }
  }
  for (const p of pods) {
    for (const c of p.spec?.containers ?? []) {
      if (c.image) runningRepos.add(imageRepoPath(c.image));
    }
  }

  for (const app of apps) {
    if (installed.has(app.id)) continue;
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
 * Pick the container image of an annotation-bound workload — mirrors the
 * `updateTargets` container-selection rule (§3.3): the `catalog-container`
 * annotation if it names an existing container; else the single container; else
 * the first container whose image matches one of `matchImages`; else the first.
 * Returns null when the workload has no usable container.
 */
function boundWorkloadImage(
  meta: { annotations?: Record<string, string> } | undefined,
  containers: Array<{ name?: string; image?: string }> | undefined,
  matchImages: string[],
): string | null {
  const list = (containers ?? []).filter((c) => !!c.image);
  if (list.length === 0) return null;
  const wantContainer = boundContainer(meta);
  if (wantContainer) {
    const named = list.find((c) => c.name === wantContainer);
    if (named?.image) return named.image;
  }
  if (list.length === 1) return list[0]!.image!;
  for (const raw of matchImages) {
    const candidate = imageRepoPath(raw);
    const m = list.find((c) => c.image && repoPathsMatch(imageRepoPath(c.image), candidate));
    if (m?.image) return m.image;
  }
  return list[0]!.image!;
}

/**
 * For each installed catalog app, the exact image reference it's running — the
 * full string (registry + repo + tag) of the matched container. This is what
 * the update check needs: the running *tag*, not just the repo path.
 *
 * Annotation wins (§3.3): an app bound to a workload via
 * `rigel.dev/catalog-app` uses that workload's container image (selected per
 * `rigel.dev/catalog-container` / single / matchImage / first), regardless of
 * image match. Otherwise the running image is found by image match across
 * Deployments/StatefulSets/DaemonSets/Pods. Apps with no match are omitted.
 * Mirrors Swift `installedImages`.
 */
export function installedImages(
  apps: CatalogApp[],
  deployments: DeploymentLike[],
  statefulSets: StatefulSetLike[],
  daemonSets: DaemonSetLike[],
  pods: PodLike[],
): InstalledImage[] {
  // Bound workloads by app id, in scan order (deployments → sts → ds). First wins.
  const boundByApp = new Map<
    string,
    { meta?: { annotations?: Record<string, string> }; containers?: Array<{ name?: string; image?: string }> }
  >();
  for (const w of [...deployments, ...statefulSets, ...daemonSets]) {
    const id = boundAppID(w.metadata);
    if (id && !boundByApp.has(id)) {
      boundByApp.set(id, { meta: w.metadata, containers: w.spec?.template?.spec?.containers });
    }
  }

  // (normalized repo path, full image ref) for every running container.
  const running: Array<{ repo: string; full: string }> = [];
  const collect = (image: string | undefined) => {
    if (image) running.push({ repo: imageRepoPath(image), full: image });
  };
  for (const d of deployments)
    for (const c of d.spec?.template?.spec?.containers ?? []) collect(c.image);
  for (const s of statefulSets)
    for (const c of s.spec?.template?.spec?.containers ?? []) collect(c.image);
  for (const ds of daemonSets)
    for (const c of ds.spec?.template?.spec?.containers ?? []) collect(c.image);
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
    // 1. Annotation-bound workload wins.
    const bound = boundByApp.get(app.id);
    if (bound) {
      const image = boundWorkloadImage(bound.meta, bound.containers, app.matchImages);
      if (image) {
        const repo = imageRepoPath(image);
        const digest = podDigests.find((d) => repoPathsMatch(d.repo, repo))?.digest;
        out.push({
          appID: app.id,
          image,
          repoURL: app.repoURL ?? undefined,
          runningDigest: digest,
        });
        continue;
      }
    }
    // 2. Image-match fallback.
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
