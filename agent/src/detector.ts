/**
 * Deterministic incident detection — the free, model-less first stage. Parses
 * `kubectl get ... -o json` output into a normalized list of incidents,
 * mirroring the queries in Sources/RigelMCP/main.swift (unhealthy pods,
 * degraded deployments) plus OOMKilled detection from a container's last
 * terminated state. Claude is only woken when one of these fires.
 */
import { scanLogsForErrors } from "./logScan.js";

export type IncidentKind = "unhealthyPod" | "degradedDeployment" | "loggedError";

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

/**
 * Fetch a bounded chunk of a pod's recent logs (returns null if unreadable, e.g.
 * RBAC denied or a multi-container pod that needs `-c`). Injected so detection
 * stays unit-testable and the actual `kubectl logs --tail` lives in one place
 * (the loop wiring) rather than coupling this module to a subprocess.
 */
export type PodLogTailer = (namespace: string, podName: string) => Promise<string | null>;

/**
 * Slice-1 bounded log-error detection: for RUNNING pods the status checks did NOT
 * already flag (an app logging errors without crashing), tail a small window of
 * recent output and run the noise-controlled signature scanner. Matches surface as
 * `loggedError` incidents whose `reason` is the normalized signature, so they
 * fingerprint, debounce (confirmPolls) and dedupe exactly like a status signal.
 *
 * `alreadyFlagged` holds `"namespace/name"` keys already covered by the status
 * checks, so we never double-report a pod. Cost is one tailer call per remaining
 * running pod — keep the tailer bounded (`--tail`/`--limit-bytes`).
 */
export async function detectLogErrors(
  raw: unknown,
  alreadyFlagged: ReadonlySet<string>,
  tail: PodLogTailer,
): Promise<Incident[]> {
  const incidents: Incident[] = [];
  for (const pod of items(raw)) {
    const phase: string = pod.status?.phase ?? "";
    if (phase !== "Running") continue;
    const name: string = pod.metadata?.name ?? "?";
    const namespace: string = pod.metadata?.namespace ?? "default";
    if (alreadyFlagged.has(`${namespace}/${name}`)) continue;

    const logText = await tail(namespace, name);
    if (logText == null) continue;
    const scan = scanLogsForErrors(logText);
    if (!scan.matched) continue;

    incidents.push({
      incidentKind: "loggedError",
      namespace,
      name,
      reason: scan.signature ?? "LogError",
      detail: scan.reason ?? "",
    });
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
