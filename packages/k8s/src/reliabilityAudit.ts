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
    }
  }
  return findings;
}
