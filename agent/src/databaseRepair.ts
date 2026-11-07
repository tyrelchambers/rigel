import type { SuggestedAction } from "./action.js";
import type { Incident } from "./detector.js";

export const REPAIR_GRACE_MS = 5 * 60_000;

export type DatabaseRepairPlan = { kind: "repair"; action: SuggestedAction } | { kind: "wait" } | null;

export function planDatabaseRepair(
  incident: Incident,
  clusters: Record<string, any>[],
  firstSeenMs: number,
  now: number,
): DatabaseRepairPlan {
  if (incident.incidentKind !== "databaseNotReady" || incident.reason !== "NoPrimary") return null;
  const cluster = clusters.find((c) => c.metadata?.name === incident.name && (c.metadata?.namespace ?? "default") === incident.namespace);
  if (cluster?.spec?.probes?.readiness?.type !== "streaming") return null;
  const failoverDelayMs = (cluster.spec?.failoverDelay ?? 0) * 1000;
  if (now - firstSeenMs < failoverDelayMs + REPAIR_GRACE_MS) return { kind: "wait" };
  return {
    kind: "repair",
    action: {
      kind: "repairDatabase",
      namespace: incident.namespace,
      cluster: incident.name,
      label: `Repair the ${incident.name} database so it can pick a new primary and come back up`,
    },
  };
}
