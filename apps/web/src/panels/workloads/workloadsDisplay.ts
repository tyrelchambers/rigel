import type {
  StatefulSet,
  DaemonSet,
  Job,
  CronJob,
  Workload,
  WorkloadKind,
} from "./types";

/**
 * Compact relative age of an ISO timestamp ("5s" / "3m" / "2h" / "1d"), or
 * "—" when missing. Mirrors the Swift `relativeAge` helper. Pass `now` for
 * determinism in tests.
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

// --- StatefulSet / DaemonSet ready fraction --------------------------------

/** "X/Y" ready-fraction text shared by StatefulSet and DaemonSet badges. */
export function readyFraction(ready: number, desired: number): string {
  return `${ready}/${desired}`;
}

/** StatefulSet ready count: `status.readyReplicas ?? 0`. */
export function statefulSetReady(sts: StatefulSet): number {
  return sts.status?.readyReplicas ?? 0;
}

/** StatefulSet desired count: `spec.replicas ?? status.replicas ?? 0`. */
export function statefulSetDesired(sts: StatefulSet): number {
  return sts.spec?.replicas ?? sts.status?.replicas ?? 0;
}

/** DaemonSet ready count: `status.numberReady ?? 0`. */
export function daemonSetReady(ds: DaemonSet): number {
  return ds.status?.numberReady ?? 0;
}

/** DaemonSet desired count: `status.desiredNumberScheduled ?? 0`. */
export function daemonSetDesired(ds: DaemonSet): number {
  return ds.status?.desiredNumberScheduled ?? 0;
}

/** Ready badge color class: green when ready===desired, red otherwise. */
export function readyColorClass(ready: number, desired: number): string {
  return ready === desired
    ? "bg-green-500/15 text-green-600 dark:text-green-400"
    : "bg-red-500/15 text-red-600 dark:text-red-400";
}

// --- Job -------------------------------------------------------------------

/**
 * Job phase. Mirrors `Sources/Helmsman/Cluster/WorkloadTypes.swift` `Job.phase`:
 * - Suspended if spec.suspend === true
 * - Failed if any condition type=Failed status=True
 * - Complete if any condition type=Complete status=True
 * - Running if status.active > 0
 * - else Pending
 */
export function jobPhase(job: Job): string {
  if (job.spec?.suspend === true) return "Suspended";
  const conditions = job.status?.conditions ?? [];
  if (conditions.some((c) => c.type === "Failed" && c.status === "True")) return "Failed";
  if (conditions.some((c) => c.type === "Complete" && c.status === "True")) return "Complete";
  if ((job.status?.active ?? 0) > 0) return "Running";
  return "Pending";
}

/** Status badge color class for a job phase. */
export function jobPhaseColorClass(phase: string): string {
  switch (phase) {
    case "Complete":
    case "Running":
      return "bg-green-500/15 text-green-600 dark:text-green-400";
    case "Failed":
      return "bg-red-500/15 text-red-600 dark:text-red-400";
    default: // Pending / Suspended
      return "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400";
  }
}

/** Map a job phase to a StatusBadge variant. */
export function jobPhaseVariant(phase: string): "healthy" | "error" | "pending" | "neutral" {
  switch (phase) {
    case "Complete":
    case "Running":
      return "healthy";
    case "Failed":
      return "error";
    default:
      return "pending";
  }
}

/**
 * Wall-clock job duration ("42s" / "5m" / "1h"), or null when not started.
 * Mirrors `Job.duration`. Pass `now` for test determinism (used as the end
 * time when the job has not completed).
 */
export function jobDuration(job: Job, now: number = Date.now()): string | null {
  const start = job.status?.startTime;
  if (!start) return null;
  const end = job.status?.completionTime ? new Date(job.status.completionTime).getTime() : now;
  const dt = (end - new Date(start).getTime()) / 1000; // seconds
  if (dt < 60) return `${Math.floor(dt)}s`;
  if (dt < 3600) return `${Math.floor(dt / 60)}m`;
  return `${Math.floor(dt / 3600)}h`;
}

/** "X/Y" completions: `status.succeeded ?? 0` / `spec.completions ?? 1`. */
export function jobCompletionsLabel(job: Job): string {
  const succeeded = job.status?.succeeded ?? 0;
  const desired = job.spec?.completions ?? 1;
  return `${succeeded}/${desired}`;
}

// --- CronJob ---------------------------------------------------------------

/**
 * Relative time since the last scheduled run ("5s ago" / "3m ago" / …), or
 * null if never scheduled. Mirrors `CronJob.lastScheduleAgo`. Pass `now` for
 * test determinism.
 */
export function lastScheduleAgo(cronJob: CronJob, now: number = Date.now()): string | null {
  const t = cronJob.status?.lastScheduleTime;
  if (!t) return null;
  const dt = (now - new Date(t).getTime()) / 1000; // seconds
  if (dt < 60) return `${Math.floor(dt)}s ago`;
  if (dt < 3600) return `${Math.floor(dt / 60)}m ago`;
  if (dt < 86400) return `${Math.floor(dt / 3600)}h ago`;
  return `${Math.floor(dt / 86400)}d ago`;
}

/** Count of currently-active jobs for a CronJob (`status.active?.length ?? 0`). */
export function cronJobActiveCount(cronJob: CronJob): number {
  return cronJob.status?.active?.length ?? 0;
}

/** True when the CronJob is suspended (`spec.suspend === true`). */
export function isCronJobSuspended(cronJob: CronJob): boolean {
  return cronJob.spec?.suspend === true;
}

/**
 * Generate a unique name for a manually triggered cronjob run. Mirrors
 * `Sources/Helmsman/Cluster/WorkloadTypes.swift` `CronJob.manualRunName`.
 * Takes `now` (ms) as a parameter for test determinism.
 */
export function generateTriggerJobName(cronName: string, now: number = Date.now()): string {
  const stamp = Math.floor(now / 1000) % 100000; // last 5 digits of Unix seconds
  const base = cronName.length > 40 ? cronName.substring(0, 40) : cronName;
  return `${base}-manual-${stamp}`;
}

// --- Search & sort ---------------------------------------------------------

/**
 * Case-insensitive substring match. Joins name + namespace + the supplied
 * per-kind extra fields with spaces and searches across the concatenation.
 * Empty/blank query matches everything.
 */
export function matchesSearch(
  name: string,
  namespace: string | undefined,
  fields: Array<string | undefined> = [],
  searchTerm: string,
): boolean {
  if (!searchTerm.trim()) return true;
  const all = [name, namespace, ...fields].filter(Boolean).join(" ");
  return all.toLowerCase().includes(searchTerm.toLowerCase());
}

/** Stable display sort: namespace ascending, then name ascending (locale-aware). */
export function compareWorkloads(a: Workload, b: Workload): number {
  const aNs = a.metadata.namespace ?? "";
  const bNs = b.metadata.namespace ?? "";
  if (aNs !== bNs) return aNs.localeCompare(bNs);
  return a.metadata.name.localeCompare(b.metadata.name);
}

/** Sort a list of workloads by namespace then name. */
export function sortWorkloads<T extends Workload>(resources: T[]): T[] {
  return [...resources].sort(compareWorkloads);
}

/** Human label for a kind (used in empty-state messages). */
export function kindLabel(kind: WorkloadKind): string {
  switch (kind) {
    case "statefulsets":
      return "StatefulSets";
    case "daemonsets":
      return "DaemonSets";
    case "jobs":
      return "Jobs";
    case "cronjobs":
      return "CronJobs";
  }
}
