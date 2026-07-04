// packages/k8s/src/reliabilityAudit.test.ts
import { describe, it, expect } from "vitest";
import {
  analyzeReliability,
  SEVERITY_RANK,
  type AuditWorkload,
} from "./reliabilityAudit";

/** A minimal healthy Deployment with 2 replicas, both probes, requests, a fixed
 *  image, anti-affinity, no hostPath — trips NOTHING. Spread + override per test. */
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
      },
    ],
    ...over,
  };
}

describe("analyzeReliability", () => {
  it("returns no findings for a healthy workload", () => {
    const out = analyzeReliability({ workloads: [healthy()], pdbs: [{ namespace: "default", selector: { app: "web" } }], hpas: [] });
    expect(out).toEqual([]);
  });

  it("exposes a severity rank ordering critical < warning < info", () => {
    expect(SEVERITY_RANK.critical).toBeLessThan(SEVERITY_RANK.warning);
    expect(SEVERITY_RANK.warning).toBeLessThan(SEVERITY_RANK.info);
  });

  it("flags a single-replica Deployment as a warning", () => {
    const out = analyzeReliability({ workloads: [healthy({ replicas: 1 })], pdbs: [], hpas: [] });
    const f = out.find((x) => x.type === "singleReplica");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("warning");
    expect(f?.container).toBeUndefined();
  });

  it("does not flag single replica when an HPA sets minReplicas >= 2", () => {
    const out = analyzeReliability({
      workloads: [healthy({ replicas: 1 })],
      pdbs: [],
      hpas: [{ namespace: "default", targetKind: "Deployment", targetName: "web", minReplicas: 2 }],
    });
    expect(out.some((x) => x.type === "singleReplica")).toBe(false);
  });

  it("does not flag single replica on a DaemonSet", () => {
    const out = analyzeReliability({ workloads: [healthy({ kind: "DaemonSet", replicas: 1 })], pdbs: [], hpas: [] });
    expect(out.some((x) => x.type === "singleReplica")).toBe(false);
  });

  it("flags a container missing a liveness probe", () => {
    const w = healthy();
    w.containers[0].hasLiveness = false;
    const out = analyzeReliability({ workloads: [w], pdbs: [{ namespace: "default", selector: { app: "web" } }], hpas: [] });
    const f = out.find((x) => x.type === "noLivenessProbe");
    expect(f?.severity).toBe("warning");
    expect(f?.container).toBe("web");
  });

  it("flags a container missing a readiness probe", () => {
    const w = healthy();
    w.containers[0].hasReadiness = false;
    const out = analyzeReliability({ workloads: [w], pdbs: [{ namespace: "default", selector: { app: "web" } }], hpas: [] });
    expect(out.some((x) => x.type === "noReadinessProbe" && x.container === "web")).toBe(true);
  });

  it("flags a container missing cpu or memory requests", () => {
    const w = healthy();
    w.containers[0].hasCpuRequest = false;
    const out = analyzeReliability({ workloads: [w], pdbs: [{ namespace: "default", selector: { app: "web" } }], hpas: [] });
    const f = out.find((x) => x.type === "missingResourceRequests");
    expect(f?.severity).toBe("warning");
    expect(f?.container).toBe("web");
  });

  it("does not flag requests when both cpu and memory are set", () => {
    const out = analyzeReliability({ workloads: [healthy()], pdbs: [{ namespace: "default", selector: { app: "web" } }], hpas: [] });
    expect(out.some((x) => x.type === "missingResourceRequests")).toBe(false);
  });
});

export { healthy };
