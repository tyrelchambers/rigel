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

export function analyzeReliability(_input: ReliabilityAuditInput): ReliabilityFinding[] {
  return [];
}
