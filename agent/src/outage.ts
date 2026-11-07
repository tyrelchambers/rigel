import type { Incident } from "./detector.js";

function deploymentOfPod(pod: Record<string, any> | undefined): string | null {
  const hash: string | undefined = pod?.metadata?.labels?.["pod-template-hash"];
  const rs = (pod?.metadata?.ownerReferences ?? []).find((o: Record<string, any>) => o.kind === "ReplicaSet")?.name as string | undefined;
  if (!hash || !rs || !rs.endsWith(`-${hash}`)) return null;
  return rs.slice(0, -(hash.length + 1));
}

function fullyDown(deps: Record<string, any>[], namespace: string, name: string): boolean {
  const d = deps.find((x) => x.metadata?.name === name && (x.metadata?.namespace ?? "default") === namespace);
  return !!d && (d.spec?.replicas ?? 1) > 0 && (d.status?.readyReplicas ?? 0) === 0;
}

export function outageOf(incident: Incident, deps: Record<string, any>[]): string | null {
  if (incident.incidentKind === "databaseNotReady" && incident.reason === "NoPrimary") return `the ${incident.name} database is down`;
  if (incident.incidentKind === "degradedDeployment" && fullyDown(deps, incident.namespace, incident.name)) return `${incident.name} is completely down`;
  return null;
}

export function outageAround(
  incident: Incident,
  incidents: Incident[],
  pods: Record<string, any>[],
  deps: Record<string, any>[],
): string | null {
  const own = outageOf(incident, deps);
  if (own) return own;
  const db = incidents.find((i) => i.incidentKind === "databaseNotReady" && i.reason === "NoPrimary");
  if (db) return `the ${db.name} database is down`;
  const pod = pods.find((p) => p.metadata?.name === incident.name && (p.metadata?.namespace ?? "default") === incident.namespace);
  const dep = deploymentOfPod(pod);
  return dep && fullyDown(deps, incident.namespace, dep) ? `${dep} is completely down` : null;
}
