/**
 * Deterministic incident detection — the free, model-less first stage. Parses
 * `kubectl get ... -o json` output into a normalized list of incidents,
 * mirroring the queries in Sources/HelmsmanMCP/main.swift (unhealthy pods,
 * degraded deployments) plus OOMKilled detection from a container's last
 * terminated state. Claude is only woken when one of these fires.
 */
export type IncidentKind = "unhealthyPod" | "degradedDeployment";

export interface Incident {
  incidentKind: IncidentKind;
  /** Namespace, or "" for cluster-scoped resources. */
  namespace: string;
  name: string;
  reason: string;
  detail: string;
  restarts?: number;
}

const BAD_WAITING_REASONS = new Set(["CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull"]);

/** Stable identity for dedup across polls — deliberately excludes volatile
 * fields (restart count, timestamps) so the same problem fingerprints the same
 * way each tick. */
export function fingerprint(i: Incident): string {
  return `${i.incidentKind}|${i.namespace}|${i.name}|${i.reason}`;
}

interface RawList {
  items?: unknown[];
}

function items(raw: unknown): Record<string, any>[] {
  const list = raw as RawList;
  return Array.isArray(list?.items) ? (list.items as Record<string, any>[]) : [];
}

export function detectUnhealthyPods(raw: unknown): Incident[] {
  const incidents: Incident[] = [];
  for (const pod of items(raw)) {
    const name: string = pod.metadata?.name ?? "?";
    const namespace: string = pod.metadata?.namespace ?? "default";
    const phase: string = pod.status?.phase ?? "";
    const containerStatuses: Record<string, any>[] = pod.status?.containerStatuses ?? [];

    let restarts = 0;
    let reason: string | undefined;
    for (const cs of containerStatuses) {
      if (typeof cs.restartCount === "number") restarts += cs.restartCount;
      const waiting = cs.state?.waiting?.reason;
      if (typeof waiting === "string" && BAD_WAITING_REASONS.has(waiting)) reason = waiting;
      const terminated = cs.lastState?.terminated?.reason ?? cs.state?.terminated?.reason;
      if (terminated === "OOMKilled") reason = "OOMKilled";
    }
    if (reason === undefined && phase === "Failed") reason = "Failed";

    if (reason !== undefined) {
      incidents.push({ incidentKind: "unhealthyPod", namespace, name, reason, detail: "", restarts });
    }
  }
  return incidents;
}

export function detectDegradedDeployments(raw: unknown): Incident[] {
  const incidents: Incident[] = [];
  for (const dep of items(raw)) {
    const name: string = dep.metadata?.name ?? "?";
    const namespace: string = dep.metadata?.namespace ?? "default";
    const desired: number = dep.spec?.replicas ?? dep.status?.replicas ?? 0;
    const ready: number = dep.status?.readyReplicas ?? 0;
    if (desired > 0 && ready < desired) {
      incidents.push({
        incidentKind: "degradedDeployment",
        namespace,
        name,
        reason: "Degraded",
        detail: `${ready}/${desired} ready`,
      });
    }
  }
  return incidents;
}
