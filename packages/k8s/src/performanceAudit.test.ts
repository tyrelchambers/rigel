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
});
