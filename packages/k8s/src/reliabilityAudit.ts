// Reliability / SRE audit — the first HELM-20 "audit skill". A pure, deterministic
// rules engine over normalized workload specs (+ PodDisruptionBudgets + HPAs). The
// source of truth for detection; the assistant only presents these findings in chat.
// Mirrors the discriminated-union + pure-helper shape of alerts.ts. Reusable by the
// web hook, a future report panel, and the in-cluster agent.

export type Severity = "critical" | "warning" | "info";
export type WorkloadKind = "Deployment" | "StatefulSet" | "DaemonSet";

/** Severity ordering for urgency-first sorting (lower = more urgent). */
export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

export interface AuditContainer {
  name: string;
  image?: string;
  hasLiveness: boolean;
  hasReadiness: boolean;
  hasCpuRequest: boolean;
  hasMemRequest: boolean;
}

export interface AuditWorkload {
  kind: WorkloadKind;
  name: string;
  namespace: string;
  /** Desired replica count. Meaningless for DaemonSets (excluded from replica checks). */
  replicas: number;
  /** Pod-template labels — used to match PodDisruptionBudget selectors. */
  labels: Record<string, string>;
  containers: AuditContainer[];
  hasAntiAffinity: boolean;
  hasHostPath: boolean;
}

export interface AuditPdb {
  namespace: string;
  /** `spec.selector.matchLabels`. Empty object matches every pod in the namespace. */
  selector: Record<string, string>;
}

export interface AuditHpa {
  namespace: string;
  targetKind: string;
  targetName: string;
  minReplicas: number;
}

export type ReliabilityFindingType =
  | "singleReplica"
  | "noLivenessProbe"
  | "noReadinessProbe"
  | "noPodDisruptionBudget"
  | "noAntiAffinity"
  | "missingResourceRequests"
  | "latestImageTag"
  | "hostPathVolume";

export interface ReliabilityFinding {
  type: ReliabilityFindingType;
  severity: Severity;
  kind: WorkloadKind;
  name: string;
  namespace: string;
  /** Set for container-scoped findings (probes, requests, image tag). */
  container?: string;
  rationale: string;
  /** Human hint describing the remediation (maps to an action-block kind). */
  fix: string;
}

export interface ReliabilityAuditInput {
  workloads: AuditWorkload[];
  pdbs: AuditPdb[];
  hpas: AuditHpa[];
}

/** Does a workload participate in replica-based checks? DaemonSets run one pod
 *  per node, so replica count / PDB / anti-affinity don't apply the same way. */
function isReplicated(w: AuditWorkload): boolean {
  return w.kind === "Deployment" || w.kind === "StatefulSet";
}

/** Is this workload scaled by an HPA that guarantees >= 2 replicas? */
function hpaKeepsMultiReplica(w: AuditWorkload, hpas: AuditHpa[]): boolean {
  return hpas.some(
    (h) =>
      h.namespace === w.namespace &&
      h.targetKind === w.kind &&
      h.targetName === w.name &&
      h.minReplicas >= 2,
  );
}

/** Extract the tag from an image ref, or null if untagged. Strips any @digest,
 *  and only treats a ':' after the last '/' as a tag (not a registry :port). */
export function imageTagIsMutable(image?: string): boolean {
  if (!image) return false;
  const noDigest = image.split("@")[0];
  const lastSlash = noDigest.lastIndexOf("/");
  const lastColon = noDigest.lastIndexOf(":");
  const tag = lastColon > lastSlash ? noDigest.slice(lastColon + 1) : null;
  return tag === null || tag === "latest"; // untagged implies :latest
}

export function analyzeReliability(input: ReliabilityAuditInput): ReliabilityFinding[] {
  const findings: ReliabilityFinding[] = [];
  for (const w of input.workloads) {
    const base = { kind: w.kind, name: w.name, namespace: w.namespace } as const;

    if (isReplicated(w) && w.replicas <= 1 && !hpaKeepsMultiReplica(w, input.hpas)) {
      findings.push({
        ...base,
        type: "singleReplica",
        severity: "warning",
        rationale: "Runs a single replica, so any pod restart, eviction, or node failure causes downtime.",
        fix: "Scale to 2 or more replicas (or set an HPA with minReplicas >= 2).",
      });
    }

    for (const c of w.containers) {
      const cbase = { ...base, container: c.name } as const;
      if (!c.hasLiveness) {
        findings.push({
          ...cbase,
          type: "noLivenessProbe",
          severity: "warning",
          rationale: "Container has no liveness probe, so Kubernetes cannot detect and restart a hung process.",
          fix: "Add a livenessProbe to the container spec.",
        });
      }
      if (!c.hasReadiness) {
        findings.push({
          ...cbase,
          type: "noReadinessProbe",
          severity: "warning",
          rationale: "Container has no readiness probe, so traffic can be routed to it before it is ready to serve.",
          fix: "Add a readinessProbe to the container spec.",
        });
      }
      if (!c.hasCpuRequest || !c.hasMemRequest) {
        const missing = [!c.hasCpuRequest ? "cpu" : null, !c.hasMemRequest ? "memory" : null]
          .filter(Boolean)
          .join(" and ");
        findings.push({
          ...cbase,
          type: "missingResourceRequests",
          severity: "warning",
          rationale: `Container has no ${missing} request, so the scheduler cannot place it reliably and it is first to be evicted under pressure.`,
          fix: "Set resources.requests for cpu and memory on the container.",
        });
      }
      if (imageTagIsMutable(c.image)) {
        findings.push({
          ...cbase,
          type: "latestImageTag",
          severity: "warning",
          rationale: "Container uses a mutable image tag (:latest or untagged), so the running image can change unexpectedly and cannot be rolled back to a known version.",
          fix: "Pin the image to a specific version tag or digest.",
        });
      }
    }
  }
  return findings;
}
