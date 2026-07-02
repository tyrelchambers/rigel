import type { Pod } from "./types";

/**
 * Compact relative age of an ISO timestamp ("5s" / "3m" / "2h" / "1d"), or
 * "—" when missing. Mirrors `K8sEvent.relativeAge()` in
 * `Sources/Rigel/Cluster/KubeTypes.swift`. Pass `now` for determinism.
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

/** Error waiting reasons that mark a pod as in a crash/error state. */
const ERROR_WAITING_REASONS = new Set([
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "ErrImagePull",
  "CreateContainerConfigError",
  "CreateContainerError",
  "InvalidImageName",
  "RunContainerError",
]);

/**
 * Tailwind color class for the pod NAME field — mirrors PodsPanel.swift
 * `statusColor()`:
 *   - red   → any container in a crash/error state, or phase "Failed"
 *   - amber → Pending
 *   - green → Running + all containers ready
 *   - default foreground otherwise (Succeeded, Unknown, etc.)
 */
export function podNameColorClass(pod: Pod): string {
  const phase = pod.status?.phase;
  if (phase === "Failed") return "text-red-600 dark:text-red-400";
  const statuses = pod.status?.containerStatuses ?? [];
  for (const c of statuses) {
    const waiting = c.state?.waiting?.reason;
    if (waiting && ERROR_WAITING_REASONS.has(waiting)) return "text-red-600 dark:text-red-400";
    const term = c.state?.terminated;
    if (term && (term.exitCode ?? 0) !== 0 && term.reason !== "Completed") {
      return "text-red-600 dark:text-red-400";
    }
  }
  if (phase === "Running") {
    const allReady = statuses.length > 0 && statuses.every((c) => c.ready);
    // Stably running → white; containers still coming up → green (deploying).
    return allReady ? "text-foreground" : "text-green-600 dark:text-green-400";
  }
  // Pending / ContainerCreating etc. — the pod is deploying → green.
  if (phase === "Pending") return "text-green-600 dark:text-green-400";
  return "text-foreground";
}

/**
 * Phase → StatusBadge variant ("healthy" | "error" | "pending" | "neutral").
 * Used to color the phase badge consistently with the theme tokens.
 */
export function phaseVariant(phase: string | undefined): "healthy" | "error" | "pending" | "neutral" {
  switch (phase) {
    case "Running":
    case "Succeeded":
      return "healthy";
    case "Failed":
      return "error";
    case "Pending":
      return "pending";
    default:
      return "neutral";
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

/**
 * Long, humanized age from an ISO timestamp: "165 days", "1 hour", "3 minutes",
 * "just now". `—` when missing/invalid. Pass `now` for test determinism.
 * (Distinct from the compact `relativeAge` — this reads as words in detail views.)
 * The shared long-form age formatter for every panel's expanded detail.
 */
export function humanAge(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const s = Math.max(0, Math.floor((now - then) / 1000));
  const units: [number, string][] = [
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [secs, label] of units) {
    if (s >= secs) {
      const n = Math.floor(s / secs);
      return `${n} ${label}${n === 1 ? "" : "s"}`;
    }
  }
  return "just now";
}

/** Stable display sort: namespace, then name. */
export function sortPods(pods: Pod[]): Pod[] {
  return [...pods].sort((a, b) => {
    const ns = (a.metadata.namespace ?? "").localeCompare(b.metadata.namespace ?? "");
    if (ns !== 0) return ns;
    return a.metadata.name.localeCompare(b.metadata.name);
  });
}
