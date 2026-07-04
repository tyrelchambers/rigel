// Performance audit — the third HELM-20 audit skill. Hybrid: spec-based checks
// always run; metrics-based checks run only when a usage provider is supplied
// (a Prometheus/VM backend was detected). Pure; reuses the shared audit core.
import {
  type AuditWorkload,
  type AuditHpa,
  type AuditFinding,
  type AuditWorkloadKind,
} from "./auditCommon";

export type PerformanceFindingType =
  | "noMemoryLimit"
  | "noAutoscaling"
  | "cpuThrottlingRisk"
  | "memoryPressure";

/** Observed-usage evidence attached to a resource finding so Rigel can size the
 *  fix from real data. Present ONLY when a metrics backend supplied usage — never
 *  fabricate values in its absence. */
export interface PerfEvidence {
  cpuPeak: number; // cores
  memPeak: number; // bytes
  cpuLimit?: number; // cores, current
  memLimit?: number; // bytes, current
  hoursCovered: number;
}

export interface PerformanceFinding extends AuditFinding {
  type: PerformanceFindingType;
  kind: AuditWorkloadKind;
  /** Observed usage for sizing the fix (present only when metrics were available). */
  evidence?: PerfEvidence;
}

/** Per-(namespace, workload, container) peak usage over the window. */
export interface PerfUsage {
  cpuPeak: number; // cores
  memPeak: number; // bytes
  hoursCovered: number;
}

export type PerfUsageProvider = (
  namespace: string,
  workload: string,
  container: string,
) => PerfUsage | undefined;

export interface PerformanceAuditInput {
  workloads: AuditWorkload[];
  hpas: AuditHpa[];
  /** Absent when no metrics backend is available — metrics checks are then skipped. */
  usage?: PerfUsageProvider;
}

const CPU_THROTTLE_FRACTION = 0.95;
/** Ignore metrics with too little history to trust (matches right-sizing's floor). */
const MIN_HOURS = 24;

function hasHpa(w: AuditWorkload, hpas: AuditHpa[]): boolean {
  return hpas.some((h) => h.namespace === w.namespace && h.targetKind === w.kind && h.targetName === w.name);
}

export function analyzePerformance(input: PerformanceAuditInput): PerformanceFinding[] {
  const findings: PerformanceFinding[] = [];
  for (const w of input.workloads) {
    const base = { kind: w.kind, name: w.name, namespace: w.namespace } as const;

    // Spec: multi-replica Deployment with no HPA can't scale to load.
    if (w.kind === "Deployment" && w.replicas >= 2 && !hasHpa(w, input.hpas)) {
      findings.push({
        ...base,
        type: "noAutoscaling",
        severity: "info",
        rationale: "Runs multiple fixed replicas with no HorizontalPodAutoscaler, so it can't scale up under load or down when idle.",
        fix: "Add a HorizontalPodAutoscaler targeting CPU or memory utilization.",
      });
    }

    for (const c of w.containers) {
      const cbase = { ...base, container: c.name } as const;
      // Observed usage for this container, if a metrics backend supplied it with
      // enough history. This is the ONLY source of resource numbers; when absent,
      // fixes stay advisory (no fabricated values).
      const u = input.usage?.(w.namespace, w.name, c.name);
      const evidence: PerfEvidence | undefined =
        u && u.hoursCovered >= MIN_HOURS
          ? { cpuPeak: u.cpuPeak, memPeak: u.memPeak, cpuLimit: c.cpuLimit, memLimit: c.memLimit, hoursCovered: u.hoursCovered }
          : undefined;

      // Spec: no memory limit → can OOM the node / noisy neighbor. Numbers (if any)
      // come from `evidence`; without it the fix is advisory.
      if (c.hasMemLimit !== true) {
        findings.push({
          ...cbase,
          type: "noMemoryLimit",
          severity: "warning",
          rationale: "Container has no memory limit, so a leak or spike can consume the node's memory and evict its neighbors.",
          fix: evidence
            ? "Set resources.limits.memory sized from the observed peak in the evidence (add best-practice headroom)."
            : "Set a memory limit, sized from observed usage — needs a metrics backend to recommend a value.",
          ...(evidence ? { evidence } : {}),
        });
      }

      // Metrics checks: only when usage is present with enough history.
      if (evidence) {
        if (c.cpuLimit !== undefined && u!.cpuPeak >= CPU_THROTTLE_FRACTION * c.cpuLimit) {
          findings.push({
            ...cbase,
            type: "cpuThrottlingRisk",
            severity: "warning",
            rationale: `Observed peak CPU (${u!.cpuPeak.toFixed(2)} cores) is at or above 95% of the ${c.cpuLimit}-core limit over the window, so the container is likely being CPU-throttled.`,
            fix: "Raise the CPU limit toward the observed peak (with headroom), or remove it if bursting is acceptable.",
            evidence,
          });
        }
      }
    }
  }
  return findings;
}
