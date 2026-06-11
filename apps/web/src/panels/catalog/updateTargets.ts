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
  boundAppID,
  boundContainer,
  type CatalogApp,
  type DeploymentLike,
  type StatefulSetLike,
  type DaemonSetLike,
  type PodLike,
} from "@helmsman/catalog";

export type WorkloadKind = "deployment" | "statefulset" | "daemonset";

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
  /** Controller kind — needed so setImage targets `statefulset/…` not `deployment/…`. */
  workloadKind: WorkloadKind;
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
  workloadKind: WorkloadKind;
  namespace: string;
  container: string;
}

/** A controller with its metadata + container list, tagged with its kind. */
interface Workload {
  kind: WorkloadKind;
  meta?: { name?: string; namespace?: string; annotations?: Record<string, string> };
  containers: Array<{ name?: string; image?: string }>;
}

/**
 * Flatten Deployments, StatefulSets, and DaemonSets into one ordered list of
 * workloads (scan order: deployments → statefulSets → daemonSets), each with its
 * metadata and container list. Used for both annotation matching and image match.
 */
function workloads(
  deployments: DeploymentLike[],
  statefulSets: StatefulSetLike[],
  daemonSets: DaemonSetLike[],
): Workload[] {
  const out: Workload[] = [];
  for (const d of deployments)
    out.push({ kind: "deployment", meta: d.metadata, containers: d.spec?.template?.spec?.containers ?? [] });
  for (const s of statefulSets)
    out.push({ kind: "statefulset", meta: s.metadata, containers: s.spec?.template?.spec?.containers ?? [] });
  for (const ds of daemonSets)
    out.push({ kind: "daemonset", meta: ds.metadata, containers: ds.spec?.template?.spec?.containers ?? [] });
  return out;
}

/**
 * Flatten workloads into one list of running containers, each tagged with its
 * normalized repo path and workload coordinates. Pods are not a controller
 * source here (no stable controller name/namespace for a setImage patch), but
 * they ARE used to recover the running digest.
 */
function runningContainers(wls: Workload[]): RunningContainer[] {
  const out: RunningContainer[] = [];
  for (const w of wls) {
    const workloadName = w.meta?.name;
    const namespace = w.meta?.namespace ?? "default";
    if (!workloadName) continue;
    for (const c of w.containers) {
      if (!c.image || !c.name) continue;
      out.push({
        repo: imageRepoPath(c.image),
        image: c.image,
        workloadName,
        workloadKind: w.kind,
        namespace,
        container: c.name,
      });
    }
  }
  return out;
}

/**
 * Container selection for an annotation-bound workload (§3.3): the
 * `catalog-container` annotation if it names an existing container; else the
 * single container; else the first container whose image matches one of
 * `matchImages`; else the first. Returns the chosen container (with name+image),
 * or null when the workload has no usable container.
 */
function selectBoundContainer(
  w: Workload,
  matchImages: string[],
): { name: string; image: string } | null {
  const list = w.containers.filter((c): c is { name: string; image: string } => !!c.name && !!c.image);
  if (list.length === 0) return null;
  const want = boundContainer(w.meta);
  if (want) {
    const named = list.find((c) => c.name === want);
    if (named) return named;
  }
  if (list.length === 1) return list[0]!;
  for (const raw of matchImages) {
    const candidate = imageRepoPath(raw);
    const m = list.find((c) => repoPathsMatch(imageRepoPath(c.image), candidate));
    if (m) return m;
  }
  return list[0]!;
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
 * For each catalog app, derive the update target (image + workload coordinates).
 * Annotation wins (§3.3): an app bound to a workload via `helmsman.dev/catalog-app`
 * targets THAT workload/container regardless of image; if multiple workloads
 * carry the annotation, the first in scan order (deployments → statefulSets →
 * daemonSets) wins. Otherwise the target is found by image match across
 * Deployments/StatefulSets/DaemonSets — first matching container wins, matching
 * the shared `installedImages` ordering. Apps with no target are omitted.
 */
export function updateTargets(
  apps: CatalogApp[],
  deployments: DeploymentLike[],
  statefulSets: StatefulSetLike[],
  daemonSets: DaemonSetLike[],
  pods: PodLike[],
): UpdateTarget[] {
  const wls = workloads(deployments, statefulSets, daemonSets);
  const running = runningContainers(wls);
  const digests = podDigests(pods);

  // Bound workload per app id, in scan order — first wins.
  const boundByApp = new Map<string, Workload>();
  for (const w of wls) {
    const id = boundAppID(w.meta);
    if (id && !boundByApp.has(id)) boundByApp.set(id, w);
  }

  const out: UpdateTarget[] = [];
  for (const app of apps) {
    // 1. Annotation-bound workload wins.
    const bound = boundByApp.get(app.id);
    if (bound && bound.meta?.name) {
      const picked = selectBoundContainer(bound, app.matchImages);
      if (picked) {
        const repo = imageRepoPath(picked.image);
        const digest = digests.find((d) => repoPathsMatch(d.repo, repo))?.digest;
        out.push({
          appID: app.id,
          image: picked.image,
          workloadName: bound.meta.name,
          workloadKind: bound.kind,
          namespace: bound.meta.namespace ?? "default",
          container: picked.name,
          repoURL: app.repoURL ?? undefined,
          runningDigest: digest,
        });
        continue;
      }
    }

    // 2. Image-match fallback.
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
      workloadKind: matched.workloadKind,
      namespace: matched.namespace,
      container: matched.container,
      repoURL: app.repoURL ?? undefined,
      runningDigest: digest,
    });
  }
  return out;
}
