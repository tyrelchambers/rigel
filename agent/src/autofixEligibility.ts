import type { Incident } from "./detector.js";
import type { AutofixConfig } from "./runtimeConfig.js";
import type { ResolvedRepo } from "./repoResolve.js";
import { isInAutofixScope, podProjectId } from "./autofixScope.js";

/**
 * Decide whether an incident's workload is autofix-eligible — the single place
 * that combines the master opt-in, the autofix scope, the owning-Deployment walk
 * and the GitOps-source lookup. Used twice per confirmed incident: Stage A tells
 * the worker it MAY open a fix PR (only when a source actually resolved), and
 * Stage B reuses the result to route an `openFixPR` proposal WITHOUT re-resolving
 * (and without mistaking a pod name for a Deployment name — the 2b deferral).
 */

export interface AutofixEligibility {
  /** autofix enabled AND the owning Deployment is within the autofix scope. */
  inScope: boolean;
  /** The resolved GitOps source — null when out of scope OR not GitOps-tracked.
   *  A non-null repo is exactly the "the worker MAY open a fix PR" signal. */
  repo: ResolvedRepo | null;
}

export interface EligibilityDeps {
  /** Resolve the workload's GitOps source (injected = `resolveWorkloadRepo`). */
  resolveRepo(namespace: string, deployment: string): Promise<ResolvedRepo | null>;
}

/**
 * The owning Deployment name for an incident, or null when it can't be named.
 * A `degradedDeployment` incident IS the Deployment (its name). A pod incident
 * (`unhealthyPod`/`loggedError`) is walked pod→ReplicaSet→Deployment via
 * `podProjectId`, looking the pod up in this tick's snapshot by namespace+name.
 * Returns null for a bare pod / Job / StatefulSet (no hash-suffixed RS owner) or
 * when the pod isn't in the snapshot, so eligibility is only attempted when the
 * Deployment can actually be named.
 */
export function incidentDeployment(incident: Incident, pods: readonly unknown[]): string | null {
  if (incident.incidentKind === "degradedDeployment") return incident.name;
  const podObj = pods.find((p) => {
    const m = (p as { metadata?: { name?: string; namespace?: string } }).metadata;
    return m?.name === incident.name && (m?.namespace ?? "default") === incident.namespace;
  });
  if (podObj === undefined) return null;
  const projectId = podProjectId(podObj);
  if (projectId === null) return null;
  const slash = projectId.indexOf("/");
  return slash === -1 ? null : projectId.slice(slash + 1);
}

/** Resolve autofix eligibility for one incident. Short-circuits (no cluster IO)
 *  when autofix is off, the owning Deployment can't be named, or the workload is
 *  out of scope — so `resolveRepo` is only hit for in-scope workloads. */
export async function resolveAutofixEligibility(
  autofix: AutofixConfig,
  incident: Incident,
  pods: readonly unknown[],
  deps: EligibilityDeps,
): Promise<AutofixEligibility> {
  if (!autofix.enabled) return { inScope: false, repo: null };
  const deployment = incidentDeployment(incident, pods);
  if (deployment === null) return { inScope: false, repo: null };
  if (!isInAutofixScope(autofix.scope, `${incident.namespace}/${deployment}`)) {
    return { inScope: false, repo: null };
  }
  const repo = await deps.resolveRepo(incident.namespace, deployment);
  return { inScope: true, repo };
}
