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

/** True when the image is untagged or pinned to :latest (a mutable reference);
 *  false for a version- or digest-pinned image. Strips any @digest, and only
 *  treats a ':' after the last '/' as a tag (not a registry :port). */
export function imageTagIsMutable(image?: string): boolean {
  if (!image) return false;
  const noDigest = image.split("@")[0];
  const lastSlash = noDigest.lastIndexOf("/");
  const lastColon = noDigest.lastIndexOf(":");
  const tag = lastColon > lastSlash ? noDigest.slice(lastColon + 1) : null;
  return tag === null || tag === "latest"; // untagged implies :latest
}

/** A PDB selects a workload when it is in the same namespace and every label in
 *  its matchLabels is present (with the same value) on the workload's pod labels.
 *  An empty selector matches every pod in the namespace. */
function pdbSelects(pdb: AuditPdb, w: AuditWorkload): boolean {
  if (pdb.namespace !== w.namespace) return false;
  return Object.entries(pdb.selector).every(([k, v]) => w.labels[k] === v);
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

    if (w.hasHostPath) {
      findings.push({
        ...base,
        type: "hostPathVolume",
        severity: "warning",
        rationale: "Pod mounts a hostPath volume, which pins it to a specific node and loses its data if the pod is rescheduled elsewhere.",
        fix: "Replace the hostPath volume with a PersistentVolumeClaim.",
      });
    }

    if (isReplicated(w) && w.replicas >= 2 && !w.hasAntiAffinity) {
      findings.push({
        ...base,
        type: "noAntiAffinity",
        severity: "info",
        rationale: "Multiple replicas have no pod anti-affinity, so Kubernetes may co-locate them on one node — a single node failure can take them all down.",
        fix: "Add podAntiAffinity across kubernetes.io/hostname to spread replicas over nodes.",
      });
    }

    if (isReplicated(w) && w.replicas >= 2 && !input.pdbs.some((p) => pdbSelects(p, w))) {
      findings.push({
        ...base,
        type: "noPodDisruptionBudget",
        severity: "warning",
        rationale: "Multiple replicas have no PodDisruptionBudget, so a voluntary disruption (node drain/upgrade) can evict every replica at once.",
        fix: "Create a PodDisruptionBudget selecting this workload (e.g. minAvailable: 1).",
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

export interface ReliabilityCounts {
  critical: number;
  warning: number;
  info: number;
  total: number;
  workloadsAffected: number;
}

/** Stable urgency-first sort: severity rank, then namespace, then name, then type. */
export function sortFindings(findings: ReliabilityFinding[]): ReliabilityFinding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.namespace.localeCompare(b.namespace) ||
      a.name.localeCompare(b.name) ||
      a.type.localeCompare(b.type),
  );
}

export function reliabilityCounts(findings: ReliabilityFinding[]): ReliabilityCounts {
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
