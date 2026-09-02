import type { ClosureMember } from "./closure";

/** Workloads with no Ingress routing to them. They post, scrape, or reconcile
 *  from both sides if home boots while the edge still points away. */
export function scaleDownOnReturn(
  closure: ClosureMember[],
  routed: Array<{ namespace: string; name: string }>,
): ClosureMember[] {
  const inbound = new Set(routed.map((r) => `${r.namespace}/${r.name}`));
  return closure.filter((m) => {
    if (m.kind !== "Deployment" && m.kind !== "StatefulSet" && m.kind !== "DaemonSet") return false;
    return !inbound.has(`${m.namespace}/${m.name}`);
  });
}

export function bothSidesNonZero(
  localReplicas: Array<{ name: string; replicas: number }>,
  remoteReplicas: Array<{ name: string; replicas: number }>,
): boolean {
  const localUp = localReplicas.some((r) => r.replicas > 0);
  const remoteUp = remoteReplicas.some((r) => r.replicas > 0);
  return localUp && remoteUp;
}

export function localWritesAfterFailover(localWriteAt: string | undefined, failoverAt: string): boolean {
  if (!localWriteAt) return false;
  return Date.parse(localWriteAt) > Date.parse(failoverAt);
}
