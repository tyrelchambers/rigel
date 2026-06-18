// Pure helpers for the GitOps panel — name slugging, default deployment-name
// derivation, and grouping linked workloads by deployment. No React imports.
import type { Deployment } from "@/panels/deployments/types";
import { linkedSourceName } from "./linkSource";
import type { GitSource, GitDeployment } from "./gitApi";

/** A deployment paired with its repo — the unit acted on by sync/link dialogs. */
export interface DeploymentRef {
  repo: GitSource;
  dep: GitDeployment;
}

/** Slug a repo's name part for the source name (matches server sanitizeSourceName). */
export function repoToName(fullName: string): string {
  const repo = fullName.split("/").pop() ?? fullName;
  return slug(repo);
}

/** Lowercase DNS-ish slug, mirroring the server's sanitizeSourceName. */
export function slug(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** A sensible default deployment name from a manifest path: the last meaningful
 *  segment, skipping generic dirs like k8s/deploy/manifests. */
export const GENERIC_DIRS = new Set(["k8s", "kubernetes", "deploy", "deployment", "manifests", "manifest", "kustomize", "base", "overlays", "prod", "production"]);
export function deriveDeployName(path: string, repoName: string): string {
  const segs = path.split("/").filter((s) => s && s !== ".");
  for (let i = segs.length - 1; i >= 0; i--) {
    if (!GENERIC_DIRS.has(segs[i]!.toLowerCase())) return slug(segs[i]!);
  }
  return slug(segs[segs.length - 1] ?? repoName);
}

/** deploymentName → linked workloads (provenance annotation = deployment name). */
export function groupLinkedByDeployment(workloads: Deployment[]): Map<string, Deployment[]> {
  const map = new Map<string, Deployment[]>();
  for (const w of workloads) {
    const dep = linkedSourceName(w);
    if (!dep) continue;
    const list = map.get(dep);
    if (list) list.push(w);
    else map.set(dep, [w]);
  }
  return map;
}
