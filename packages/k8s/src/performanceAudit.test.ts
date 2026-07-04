// packages/k8s/src/performanceAudit.test.ts
import { describe, it, expect } from "vitest";
import { analyzePerformance, type PerfUsageProvider } from "./performanceAudit";
import { type AuditWorkload, type AuditHpa } from "./auditCommon";

/** A healthy Deployment: a memory limit set, an HPA covering it, and (when a
 *  usage provider is supplied) usage well under both limits — trips NOTHING. */
function healthy(over: Partial<AuditWorkload> = {}): AuditWorkload {
  return {
    kind: "Deployment",
    name: "web",
    namespace: "default",
    replicas: 2,
    labels: { app: "web" },
    hasAntiAffinity: true,
    hasHostPath: false,
    containers: [
      {
        name: "web",
        image: "nginx:1.27.0",
        hasLiveness: true,
        hasReadiness: true,
        hasCpuRequest: true,
        hasMemRequest: true,
        hasCpuLimit: true,
        hasMemLimit: true,
        cpuLimit: 1, // cores
        memLimit: 1_000_000_000, // bytes
      },
    ],
    ...over,
  };
}

const HPA_FOR_WEB: AuditHpa = { namespace: "default", targetKind: "Deployment", targetName: "web", minReplicas: 2 };

/** Usage well under both limits, with a full 30-day window. */
const healthyUsage: PerfUsageProvider = () => ({ cpuPeak: 0.1, memPeak: 100_000_000, hoursCovered: 30 * 24 });

describe("analyzePerformance", () => {
  it("returns no findings for a healthy workload (spec-only, no usage)", () => {
    const out = analyzePerformance({ workloads: [healthy()], hpas: [HPA_FOR_WEB] });
    expect(out).toEqual([]);
  });

  it("returns no findings for a healthy workload with healthy usage", () => {
    const out = analyzePerformance({ workloads: [healthy()], hpas: [HPA_FOR_WEB], usage: healthyUsage });
    expect(out).toEqual([]);
  });

  it("flags a container missing a memory limit, and clears when one is set", () => {
    const w = healthy();
    w.containers[0].hasMemLimit = false;
    const out = analyzePerformance({ workloads: [w], hpas: [HPA_FOR_WEB] });
    const f = out.find((x) => x.type === "noMemoryLimit");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("warning");
    expect(f?.container).toBe("web");

    const clean = analyzePerformance({ workloads: [healthy()], hpas: [HPA_FOR_WEB] });
    expect(clean.some((x) => x.type === "noMemoryLimit")).toBe(false);
  });

  it("flags a multi-replica Deployment with no HPA as info, and clears when an HPA targets it", () => {
    const withoutHpa = analyzePerformance({ workloads: [healthy()], hpas: [] });
    const f = withoutHpa.find((x) => x.type === "noAutoscaling");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("info");
    expect(f?.container).toBeUndefined();

    const withHpa = analyzePerformance({ workloads: [healthy()], hpas: [HPA_FOR_WEB] });
    expect(withHpa.some((x) => x.type === "noAutoscaling")).toBe(false);
  });

  it("does not flag noAutoscaling on a single-replica Deployment", () => {
    const out = analyzePerformance({ workloads: [healthy({ replicas: 1 })], hpas: [] });
    expect(out.some((x) => x.type === "noAutoscaling")).toBe(false);
  });

  it("does not flag noAutoscaling on a StatefulSet, even with multiple replicas and no HPA", () => {
    const out = analyzePerformance({ workloads: [healthy({ kind: "StatefulSet" })], hpas: [] });
    expect(out.some((x) => x.type === "noAutoscaling")).toBe(false);
  });

  it("flags cpuThrottlingRisk when observed peak CPU is >= 95% of the limit, carrying evidence", () => {
    const hotCpu: PerfUsageProvider = () => ({ cpuPeak: 0.96, memPeak: 100_000_000, hoursCovered: 30 * 24 });
    const out = analyzePerformance({ workloads: [healthy()], hpas: [HPA_FOR_WEB], usage: hotCpu });
    const f = out.find((x) => x.type === "cpuThrottlingRisk");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("warning");
    expect(f?.container).toBe("web");
    expect(f?.evidence).toEqual({ cpuPeak: 0.96, memPeak: 100_000_000, cpuLimit: 1, memLimit: 1_000_000_000, hoursCovered: 30 * 24 });
  });

  it("does not flag cpuThrottlingRisk when no usage provider is supplied (spec-only degradation)", () => {
    // Same workload shape that would trip cpuThrottlingRisk if usage were supplied,
    // but no `usage` provider at all means the metrics checks never run.
    const out = analyzePerformance({ workloads: [healthy()], hpas: [HPA_FOR_WEB] });
    expect(out.some((x) => x.type === "cpuThrottlingRisk")).toBe(false);
    // And the spec-only findings that DID run carry no evidence.
    expect(out.every((f) => f.evidence === undefined)).toBe(true);
  });

  it("skips metrics checks entirely when hoursCovered is below the 24h floor", () => {
    const tooLittleHistory: PerfUsageProvider = () => ({ cpuPeak: 0.99, memPeak: 999_000_000, hoursCovered: 10 });
    const out = analyzePerformance({ workloads: [healthy()], hpas: [HPA_FOR_WEB], usage: tooLittleHistory });
    expect(out.some((x) => x.type === "cpuThrottlingRisk")).toBe(false);
    expect(out.some((x) => x.type === "memoryPressure")).toBe(false);
  });

  it("flags memoryPressure when observed peak memory is >= 90% of the limit, carrying evidence", () => {
    const hotMem: PerfUsageProvider = () => ({ cpuPeak: 0.1, memPeak: 950_000_000, hoursCovered: 30 * 24 });
    const out = analyzePerformance({ workloads: [healthy()], hpas: [HPA_FOR_WEB], usage: hotMem });
    const f = out.find((x) => x.type === "memoryPressure");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("warning");
    expect(f?.container).toBe("web");
    expect(f?.evidence).toEqual({ cpuPeak: 0.1, memPeak: 950_000_000, cpuLimit: 1, memLimit: 1_000_000_000, hoursCovered: 30 * 24 });
  });

  it("does not flag memoryPressure when no usage provider is supplied (spec-only degradation)", () => {
    const out = analyzePerformance({ workloads: [healthy()], hpas: [HPA_FOR_WEB] });
    expect(out.some((x) => x.type === "memoryPressure")).toBe(false);
  });
});
