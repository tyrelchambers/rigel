import type { Pod } from "./types";

/**
 * Compact relative age of an ISO timestamp ("5s" / "3m" / "2h" / "1d"), or
 * "—" when missing. Mirrors `K8sEvent.relativeAge()` in
 * `Sources/Helmsman/Cluster/KubeTypes.swift`. Pass `now` for determinism.
 */
export function relativeAge(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const dt = (now - then) / 1000; // seconds
  if (dt < 0) return "0s";
  if (dt < 60) return `${Math.floor(dt)}s`;
  if (dt < 3600) return `${Math.floor(dt / 60)}m`;
  if (dt < 86400) return `${Math.floor(dt / 3600)}h`;
  return `${Math.floor(dt / 86400)}d`;
}

/** Phase → pill color class. Unknown phases render gray; nil handled by caller. */
export function phaseColorClass(phase: string | undefined): string {
  switch (phase) {
    case "Running":
    case "Succeeded":
      return "bg-green-500/15 text-green-600 dark:text-green-400";
    case "Pending":
      return "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400";
    case "Failed":
      return "bg-red-500/15 text-red-600 dark:text-red-400";
    default:
      return "bg-muted text-muted-foreground";
  }
}

/**
 * `<ready_count>/<total>` from `status.containerStatuses`, or "—" when there
 * are no statuses.
 */
export function readyText(pod: Pod): string {
  const statuses = pod.status?.containerStatuses;
  if (!statuses || statuses.length === 0) return "—";
  const ready = statuses.filter((c) => c.ready).length;
  return `${ready}/${statuses.length}`;
}

/** Sum of all container restart counts (0 when no statuses). */
export function restartCount(pod: Pod): number {
  const statuses = pod.status?.containerStatuses;
  if (!statuses || statuses.length === 0) return 0;
  return statuses.reduce((sum, c) => sum + (c.restartCount ?? 0), 0);
}

/**
 * Case-insensitive substring match against pod name, namespace, and label
 * keys/values. Empty/blank query matches everything.
 */
export function matchesSearch(pod: Pod, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  if (pod.metadata.name.toLowerCase().includes(q)) return true;
  if (pod.metadata.namespace?.toLowerCase().includes(q)) return true;
  const labels = pod.metadata.labels ?? {};
  for (const [k, v] of Object.entries(labels)) {
    if (k.toLowerCase().includes(q) || v.toLowerCase().includes(q)) return true;
  }
  return false;
}

/** Stable display sort: namespace, then name. */
export function sortPods(pods: Pod[]): Pod[] {
  return [...pods].sort((a, b) => {
    const ns = (a.metadata.namespace ?? "").localeCompare(b.metadata.namespace ?? "");
    if (ns !== 0) return ns;
    return a.metadata.name.localeCompare(b.metadata.name);
  });
}
