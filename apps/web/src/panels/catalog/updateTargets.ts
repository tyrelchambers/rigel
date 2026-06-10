// Per-installed-app update targets — pure helpers so the Catalog panel can wire
// the /api/updates query and the [Update] setImage action without leaking
// matching logic into JSX. Mirrors the shared detection logic
// (`installedImages`) but additionally carries the workload coordinates a
// setImage action needs: controller name, namespace, and container name.
//
// We don't extend the shared `installedImages` (which intentionally mirrors the
// Swift port and only returns appID/image/repoURL/runningDigest) — the workload
// target is a web-panel concern for the Update button, kept local here.

import {
  imageRepoPath,
  repoPathsMatch,
  runningImageDigest,
  type CatalogApp,
  type DeploymentLike,
  type StatefulSetLike,
  type PodLike,
} from "@helmsman/catalog";

/**
 * Reconstruct a full image reference with a new tag — the exact `image` field a
 * `setImage` action needs when the user clicks [Update]. Drops any `@sha256:…`
 * digest and the running tag (the `:` after the last `/`), then appends the new
 * tag. The registry host and repo path are preserved verbatim.
 *
 *   withTag("ghcr.io/x/y:v1.2.3", "v1.3.0") -> "ghcr.io/x/y:v1.3.0"
 *   withTag("nextcloud:29-apache", "30")    -> "nextcloud:30"
 *   withTag("repo/app@sha256:ab", "v2")      -> "repo/app:v2"
 */
export function withTag(image: string, newTag: string): string {
  let s = image;
  const at = s.indexOf("@");
  if (at !== -1) s = s.slice(0, at);
  const slash = s.lastIndexOf("/");
  if (slash !== -1) {
    const colon = s.indexOf(":", slash + 1);
    if (colon !== -1) s = s.slice(0, colon);
  } else {
    const colon = s.indexOf(":");
    if (colon !== -1) s = s.slice(0, colon);
  }
  return `${s}:${newTag}`;
}

/** Everything the Catalog panel needs to check + apply an update for one app. */
export interface UpdateTarget {
  appID: string;
  /** Full running image reference, e.g. "ghcr.io/x/y:v1.2.3". */
  image: string;
  /** Controller name (`metadata.name`) carrying the matched container. */
  workloadName: string;
  /** Controller namespace. */
  namespace: string;
  /** Container name within the controller (for the setImage action). */
  container: string;
  /** App's GitHub repo, if any (for the response tooltip / context). */
  repoURL?: string;
  /** sha256:… the pod actually pulled (moving-tag digest tier context). */
  runningDigest?: string;
}

interface RunningContainer {
  repo: string;
  image: string;
  workloadName: string;
  namespace: string;
  container: string;
}

/**
 * Flatten Deployments + StatefulSets into one list of running containers, each
 * tagged with its normalized repo path and workload coordinates. Pods are not a
 * controller source here (no stable controller name/namespace for a setImage
 * patch), but they ARE used to recover the running digest.
 */
function runningContainers(
  deployments: DeploymentLike[],
  statefulSets: StatefulSetLike[],
): RunningContainer[] {
  const out: RunningContainer[] = [];
  const add = (
    meta: { name?: string; namespace?: string } | undefined,
    containers: Array<{ name?: string; image?: string }> | undefined,
  ) => {
    const workloadName = meta?.name;
    const namespace = meta?.namespace ?? "default";
    if (!workloadName) return;
    for (const c of containers ?? []) {
      if (!c.image || !c.name) continue;
      out.push({
        repo: imageRepoPath(c.image),
        image: c.image,
        workloadName,
        namespace,
        container: c.name,
      });
    }
  };
  for (const d of deployments) add(d.metadata, d.spec?.template?.spec?.containers);
  for (const s of statefulSets) add(s.metadata, s.spec?.template?.spec?.containers);
  return out;
}

/** (normalized repo path → running digest) recovered from pod status. */
function podDigests(pods: PodLike[]): Array<{ repo: string; digest: string }> {
  const out: Array<{ repo: string; digest: string }> = [];
  for (const p of pods) {
    const idByName = new Map<string, string>();
    for (const cs of p.status?.containerStatuses ?? []) {
      if (cs.name && cs.imageID) idByName.set(cs.name, cs.imageID);
    }
    for (const c of p.spec?.containers ?? []) {
      const digest = c.name ? runningImageDigest(idByName.get(c.name)) : null;
      if (!c.image || !digest) continue;
      out.push({ repo: imageRepoPath(c.image), digest });
    }
  }
  return out;
}

/**
 * For each catalog app whose image is running on a Deployment/StatefulSet,
 * derive the update target (image + workload coordinates). Apps with no matching
 * controller container are omitted. The first matching container wins, matching
 * the shared `installedImages` ordering.
 */
export function updateTargets(
  apps: CatalogApp[],
  deployments: DeploymentLike[],
  statefulSets: StatefulSetLike[],
  pods: PodLike[],
): UpdateTarget[] {
  const running = runningContainers(deployments, statefulSets);
  const digests = podDigests(pods);

  const out: UpdateTarget[] = [];
  for (const app of apps) {
    let matched: RunningContainer | undefined;
    for (const raw of app.matchImages) {
      const candidate = imageRepoPath(raw);
      matched = running.find((r) => repoPathsMatch(r.repo, candidate));
      if (matched) break;
    }
    if (!matched) continue;
    const digest = digests.find((d) => repoPathsMatch(d.repo, matched!.repo))?.digest;
    out.push({
      appID: app.id,
      image: matched.image,
      workloadName: matched.workloadName,
      namespace: matched.namespace,
      container: matched.container,
      repoURL: app.repoURL ?? undefined,
      runningDigest: digest,
    });
  }
  return out;
}
