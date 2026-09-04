import { parseQuantity } from "../quantity";
import type { ClusterObject } from "../workloadClosure";
import type { ClosureMember } from "./closure";
import { endpointIsInsideSourceCluster } from "./inClusterEndpoint";
import { objectStoreEndpoint } from "./portabilityAudit";
import type { DataPlan, PortabilityFinding } from "./types";

export interface DataPlanInput {
  closure: ClosureMember[];
  clusters: ClusterObject[];
  objectStores: ClusterObject[];
  pvcs: ClusterObject[];
  acceptedRewrites?: Array<{ rule: string; to: unknown }>;
}

function pvcBytes(pvc: ClusterObject): number | undefined {
  const cap =
    (pvc.status as { capacity?: { storage?: string } } | undefined)?.capacity?.storage ??
    (pvc.spec as { resources?: { requests?: { storage?: string } } } | undefined)?.resources?.requests?.storage;
  if (!cap) return undefined;
  const n = parseQuantity(cap, "memory");
  return n > 0 ? n : undefined;
}

function clusterObjectStoreName(cluster: ClusterObject): string | undefined {
  const spec = cluster.spec as {
    plugins?: Array<{ name?: string; parameters?: Record<string, string> }>;
    backup?: { barmanObjectStore?: unknown; pluginConfiguration?: { name?: string } };
  } | undefined;
  const fromPlugin = spec?.plugins?.find((p) => (p.name ?? "").includes("barman"))?.parameters?.barmanObjectName;
  if (fromPlugin) return fromPlugin;
  return undefined;
}

function isRedis(member: ClosureMember, pvc: ClusterObject): boolean {
  const name = `${member.name} ${pvc.metadata?.name ?? ""}`.toLowerCase();
  return name.includes("redis") || name.includes("cache");
}

function cnpgOwnsPvc(pvc: ClusterObject, clusters: ClusterObject[]): boolean {
  const owners = (pvc.metadata as { ownerReferences?: Array<{ kind?: string; name?: string }> } | undefined)
    ?.ownerReferences ?? [];
  if (owners.some((o) => o.kind === "Cluster")) return true;
  const name = pvc.metadata?.name ?? "";
  return clusters.some((c) => name.startsWith(`${c.metadata?.name ?? ""}-`));
}

/** One plan per stateful dependency. In-cluster barman is not silently dumped. */
export function planData(input: DataPlanInput): { plans: DataPlan[]; blockers: PortabilityFinding[] } {
  const plans: DataPlan[] = [];
  const blockers: PortabilityFinding[] = [];
  const acceptPgDump = (input.acceptedRewrites ?? []).some(
    (r) => r.rule === "backupTargetIsInsideSourceCluster" && r.to === "pgDump",
  );

  for (const cluster of input.clusters) {
    const subject = {
      kind: "Cluster",
      namespace: cluster.metadata?.namespace ?? "",
      name: cluster.metadata?.name ?? "",
    };
    const storeName = clusterObjectStoreName(cluster);
    const store = storeName
      ? input.objectStores.find((o) => o.metadata?.name === storeName)
      : input.objectStores[0];
    const endpoint = store ? objectStoreEndpoint(store) : "";
    const inCluster = store ? endpointIsInsideSourceCluster(endpoint) : false;

    if (store && inCluster && !acceptPgDump) {
      blockers.push({
        rule: "backupTargetIsInsideSourceCluster",
        severity: "blocker",
        subject,
        whatsWrong:
          "This cluster archives to an ObjectStore inside the source cluster. Accept pg_dump or add an off-site store.",
        rewrite: { label: "Dump with pg_dump instead", from: "cnpgBarman", to: "pgDump" },
      });
      continue;
    }
    if (store && !inCluster) {
      plans.push({ subject, kind: "cnpgBarman" });
      continue;
    }
    plans.push({
      subject,
      kind: "pgDump",
      warning: store ? "ObjectStore is inside the source cluster, so this run dumps with pg_dump." : undefined,
    });
  }

  for (const pvc of input.pvcs) {
    if (cnpgOwnsPvc(pvc, input.clusters)) continue;
    const subject = {
      kind: "PersistentVolumeClaim",
      namespace: pvc.metadata?.namespace ?? "",
      name: pvc.metadata?.name ?? "",
    };
    const member = input.closure.find((m) => m.kind === "PersistentVolumeClaim" && m.name === subject.name);
    if (member && isRedis(member, pvc)) {
      plans.push({
        subject,
        kind: "startEmpty",
        warning: "Cache will start empty. Workloads that depend on it will refill it.",
      });
      continue;
    }
    plans.push({ subject, kind: "pvcTar", bytes: pvcBytes(pvc) });
  }

  const stateful = input.closure.filter(
    (m) => m.kind === "PersistentVolumeClaim" || m.kind === "Cluster" || m.kind === "StatefulSet",
  );
  for (const m of stateful) {
    if (m.kind === "StatefulSet") continue;
    const covered = plans.some((p) => p.subject.name === m.name && p.subject.namespace === m.namespace);
    const blocked = blockers.some((b) => b.subject.name === m.name && b.subject.namespace === m.namespace);
    if (!covered && !blocked) {
      blockers.push({
        rule: "statefulDataPlanMissing",
        severity: "blocker",
        subject: { kind: m.kind, namespace: m.namespace, name: m.name },
        whatsWrong: "No data plan for this stateful dependency.",
      });
    }
  }

  return { plans, blockers };
}
