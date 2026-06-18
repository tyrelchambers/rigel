// Normalizes the four log-source kinds (Deployments / StatefulSets / DaemonSets
// / Pods) into a uniform SidebarItem so the Logs sidebar is kind-agnostic.
// Workloads stream via their label selector; pods stream by name.
import { labelSelector } from "./logDisplay";

export type LogKind = "deployments" | "statefulsets" | "daemonsets" | "pods";

/** Tab order + short labels for the sidebar kind selector. */
export const LOG_KINDS: { kind: LogKind; label: string }[] = [
  { kind: "deployments", label: "Deploy" },
  { kind: "statefulsets", label: "STS" },
  { kind: "daemonsets", label: "DS" },
  { kind: "pods", label: "Pods" },
];

/** A uniform sidebar row across all kinds. */
export interface SidebarItem {
  key: string;
  name: string;
  namespace: string;
  /** "ready/total" for workloads, pod phase for pods. */
  statusText: string;
  /** True when not fully ready / not Running (status shown in red). */
  unhealthy: boolean;
  /** Label selector to tail (workloads); null for pods. */
  selector: string | null;
  /** Pod name to tail (pods); null for workloads. */
  pod: string | null;
}

interface RawObj {
  metadata?: { name?: string; namespace?: string };
  spec?: { selector?: { matchLabels?: Record<string, string> } };
  status?: {
    readyReplicas?: number; replicas?: number;
    numberReady?: number; desiredNumberScheduled?: number;
    phase?: string;
  };
}

function statusFor(kind: LogKind, o: RawObj): { statusText: string; unhealthy: boolean } {
  if (kind === "pods") {
    const phase = o.status?.phase ?? "Unknown";
    return { statusText: phase, unhealthy: phase !== "Running" && phase !== "Succeeded" };
  }
  let ready = 0;
  let total = 0;
  if (kind === "daemonsets") {
    ready = o.status?.numberReady ?? 0;
    total = o.status?.desiredNumberScheduled ?? 0;
  } else {
    ready = o.status?.readyReplicas ?? 0;
    total = o.status?.replicas ?? 0;
  }
  return { statusText: `${ready}/${total}`, unhealthy: ready < total };
}

/** Build the sorted, search-filtered sidebar list for one kind. */
export function buildSidebarItems(
  resources: Record<string, Record<string, unknown>>,
  kind: LogKind,
  search: string,
): SidebarItem[] {
  const q = search.trim().toLowerCase();
  const raw = (resources[kind] ?? {}) as Record<string, RawObj>;
  const items: SidebarItem[] = [];
  for (const o of Object.values(raw)) {
    const name = o.metadata?.name ?? "";
    const namespace = o.metadata?.namespace ?? "default";
    if (q && !name.toLowerCase().includes(q)) continue;
    const { statusText, unhealthy } = statusFor(kind, o);
    items.push({
      key: `${namespace}/${name}`,
      name,
      namespace,
      statusText,
      unhealthy,
      selector: kind === "pods" ? null : labelSelector(o),
      pod: kind === "pods" ? name : null,
    });
  }
  return items.sort((a, b) =>
    a.namespace === b.namespace ? a.name.localeCompare(b.name) : a.namespace.localeCompare(b.namespace),
  );
}
