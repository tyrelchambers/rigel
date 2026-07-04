// Shared primitives for the HELM-20 audit skills (reliability / security /
// performance). Finding-shape-agnostic: severity, ordering, the base finding
// interface, the normalized workload inputs (one adapter feeds all engines), and
// the generic sort + counts. Each engine defines its own `type` union on top.

export type Severity = "critical" | "warning" | "info";

/** Severity ordering for urgency-first sorting (lower = more urgent). */
export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export type AuditWorkloadKind = "Deployment" | "StatefulSet" | "DaemonSet";

/** The base shape every audit's finding conforms to. */
export interface AuditFinding {
  type: string;
  severity: Severity;
  kind: AuditWorkloadKind;
  name: string;
  namespace: string;
  /** Set for container-scoped findings. */
  container?: string;
  rationale: string;
  /** Human hint describing the remediation (maps to an action-block kind). */
  fix: string;
}

export interface AuditContainer {
  name: string;
  image?: string;
  // reliability
  hasLiveness: boolean;
  hasReadiness: boolean;
  hasCpuRequest: boolean;
  hasMemRequest: boolean;
  // security (all optional/additive)
  privileged?: boolean;
  allowPrivilegeEscalation?: boolean;
  runAsNonRoot?: boolean;
  runAsUser?: number;
  readOnlyRootFilesystem?: boolean;
  addedCapabilities?: string[];
  hostPorts?: number[];
  // performance
  hasCpuLimit?: boolean;
  hasMemLimit?: boolean;
  cpuLimit?: number; // cores
  memLimit?: number; // bytes
}

export interface AuditWorkload {
  kind: AuditWorkloadKind;
  name: string;
  namespace: string;
  /** Desired replica count. Meaningless for DaemonSets. */
  replicas: number;
  /** Pod-template labels — used to match PodDisruptionBudget selectors. */
  labels: Record<string, string>;
  containers: AuditContainer[];
  hasAntiAffinity: boolean;
  hasHostPath: boolean;
  // security (pod-level, optional/additive)
  hostNetwork?: boolean;
  hostPID?: boolean;
  hostIPC?: boolean;
  podRunAsNonRoot?: boolean;
  podRunAsUser?: number;
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

export interface AuditCounts {
  critical: number;
  warning: number;
  info: number;
  total: number;
  workloadsAffected: number;
}

/** Stable urgency-first sort: severity rank, then namespace, name, type. */
export function sortFindings<T extends AuditFinding>(findings: T[]): T[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.namespace.localeCompare(b.namespace) ||
      a.name.localeCompare(b.name) ||
      a.type.localeCompare(b.type),
  );
}

export function auditCounts(findings: AuditFinding[]): AuditCounts {
  const affected = new Set<string>();
  let critical = 0;
  let warning = 0;
  let info = 0;
  for (const f of findings) {
    affected.add(`${f.kind}/${f.namespace}/${f.name}`);
    if (f.severity === "critical") critical++;
    else if (f.severity === "warning") warning++;
    else info++;
  }
  return { critical, warning, info, total: findings.length, workloadsAffected: affected.size };
}
