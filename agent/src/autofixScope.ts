import type { AutofixConfig, AutofixScope } from "./runtimeConfig.js";

/**
 * Autofix scope matching — the single deterministic gate deciding whether autofix
 * (agent-opened fix PRs + the log-error scan that feeds them) may touch a given
 * workload. A workload is in scope IFF its specific PROJECT id
 * (`namespace/deployment`) is opted in. Per-project ONLY: a namespace holds
 * deployments from many different repos, so a whole-namespace opt-in is never
 * one-to-one. All pure; the master `autofixEnabled` flag is checked by the caller.
 */

/** Is a workload (by its `namespace/deployment` project id) in scope? */
export function isInAutofixScope(scope: AutofixScope, projectId: string): boolean {
  return scope.projects.includes(projectId);
}

/**
 * Best-effort `namespace/deployment` project id for a pod, derived from its
 * controlling ReplicaSet ownerReference (the standard Deployment→ReplicaSet→Pod
 * chain): strip the trailing pod-template-hash segment from the ReplicaSet name.
 * Returns null when the pod isn't owned by a hash-suffixed ReplicaSet (a bare pod,
 * a Job, a StatefulSet/DaemonSet), so a project match is only attempted when the
 * owning Deployment can actually be named.
 */
export function podProjectId(pod: unknown): string | null {
  const p = pod as {
    metadata?: { namespace?: string; ownerReferences?: { kind?: string; name?: string }[] };
  };
  const ns = p.metadata?.namespace ?? "default";
  const rs = (p.metadata?.ownerReferences ?? []).find((o) => o.kind === "ReplicaSet" && typeof o.name === "string");
  if (!rs || typeof rs.name !== "string") return null;
  const m = /^(.+)-[a-z0-9]+$/.exec(rs.name);
  if (!m || !m[1]) return null;
  return `${ns}/${m[1]}`;
}

/** Whether a pod is within the autofix scope — its derived `namespace/deployment`
 *  project opted in. A pod with no derivable project id is never in scope. */
export function podInAutofixScope(scope: AutofixScope, pod: unknown): boolean {
  const projectId = podProjectId(pod);
  return projectId !== null && isInAutofixScope(scope, projectId);
}

/**
 * The pods the bounded log-error scan should tail this tick: NONE when autofix is
 * disabled (pre-2a behavior — no log tailing at all), else only the in-scope pods.
 * This bounds the `kubectl logs` calls to the small opted-in surface.
 */
export function selectLogScanPods<T>(autofix: AutofixConfig, pods: readonly T[]): T[] {
  if (!autofix.enabled) return [];
  return pods.filter((p) => podInAutofixScope(autofix.scope, p));
}
