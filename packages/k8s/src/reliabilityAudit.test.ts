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
});

export { healthy };
