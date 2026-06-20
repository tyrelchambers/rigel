// Pure helpers for the LinkWorkloadPickerSheet. The picker lists all
// Deployments/StatefulSets/DaemonSets across namespaces so a user can manually
// bind a catalog app to a running workload (docs/parity/catalog-link-workload.md
// §5). Unlike the purge picker, linking is read-then-annotate (not a delete), so
// NO namespace is filtered out.

import {
  boundAppID,
  boundContainer,
  type DeploymentLike,
  type StatefulSetLike,
  type DaemonSetLike,
} from "@rigel/catalog";
import type { WorkloadKind } from "./updateTargets";

/** One selectable workload row in the picker. */
export interface PickableWorkload {
  kind: WorkloadKind;
  name: string;
  namespace: string;
  /** Container names from the pod template (drives the conditional step 2). */
  containers: Array<{ name: string; image?: string }>;
  /** The catalog app this workload is already bound to, if any (secondary text). */
  boundTo: string | null;
  /** The bound container, if any. */
  boundContainer: string | null;
}

/** A namespace group of pickable workloads (names sorted within). */
export interface WorkloadGroup {
  namespace: string;
  workloads: PickableWorkload[];
}

/**
 * Flatten Deployments/StatefulSets/DaemonSets into one ordered list of pickable
 * workloads (scan order: deployments → statefulSets → daemonSets), reading the
 * binding annotation + container list off each.
 */
export function pickableWorkloads(
  deployments: DeploymentLike[],
  statefulSets: StatefulSetLike[],
  daemonSets: DaemonSetLike[],
): PickableWorkload[] {
  const out: PickableWorkload[] = [];
  const add = (
    kind: WorkloadKind,
    meta: { name?: string; namespace?: string; annotations?: Record<string, string> } | undefined,
    containers: Array<{ name?: string; image?: string }> | undefined,
  ) => {
    const name = meta?.name;
    if (!name) return;
    out.push({
      kind,
      name,
      namespace: meta?.namespace ?? "default",
      containers: (containers ?? [])
        .filter((c): c is { name: string; image?: string } => !!c.name)
        .map((c) => ({ name: c.name, image: c.image })),
      boundTo: boundAppID(meta),
      boundContainer: boundContainer(meta),
    });
  };
  for (const d of deployments) add("deployment", d.metadata, d.spec?.template?.spec?.containers);
  for (const s of statefulSets) add("statefulset", s.metadata, s.spec?.template?.spec?.containers);
  for (const ds of daemonSets) add("daemonset", ds.metadata, ds.spec?.template?.spec?.containers);
  return out;
}

/**
 * Group workloads by namespace, filtered by a case-insensitive search that
 * matches the workload name OR the namespace substring. Namespaces and names are
 * returned sorted; empty groups are dropped.
 */
export function groupWorkloadsByNamespace(
  workloads: PickableWorkload[],
  search: string,
): WorkloadGroup[] {
  const q = search.trim().toLowerCase();
  const byNs = new Map<string, PickableWorkload[]>();

  for (const w of workloads) {
    const matches =
      q === "" || w.name.toLowerCase().includes(q) || w.namespace.toLowerCase().includes(q);
    if (!matches) continue;
    const list = byNs.get(w.namespace) ?? [];
    list.push(w);
    byNs.set(w.namespace, list);
  }

  return [...byNs.entries()]
    .map(([namespace, list]) => ({
      namespace,
      workloads: [...list].sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.namespace.localeCompare(b.namespace));
}
