// packages/k8s/src/reliabilityAudit.test.ts
import { describe, it, expect } from "vitest";
import {
  analyzeReliability,
  sortFindings,
  reliabilityCounts,
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

  it("flags a :latest image and an untagged image, but not a pinned one", () => {
    const latest = healthy({ name: "a", labels: { app: "a" } });
    latest.containers[0].image = "nginx:latest";
    const untagged = healthy({ name: "b", labels: { app: "b" } });
    untagged.containers[0].image = "nginx";
    const pinned = healthy({ name: "c", labels: { app: "c" } });
    pinned.containers[0].image = "registry:5000/nginx:1.27.0";
    const pdbs = ["a", "b", "c"].map((app) => ({ namespace: "default", selector: { app } }));
    const out = analyzeReliability({ workloads: [latest, untagged, pinned], pdbs, hpas: [] });
    const flagged = out.filter((x) => x.type === "latestImageTag").map((x) => x.name).sort();
    expect(flagged).toEqual(["a", "b"]);
  });

  it("flags a workload with a hostPath volume", () => {
    const out = analyzeReliability({
      workloads: [healthy({ hasHostPath: true })],
      pdbs: [{ namespace: "default", selector: { app: "web" } }],
      hpas: [],
    });
    const f = out.find((x) => x.type === "hostPathVolume");
    expect(f?.severity).toBe("warning");
    expect(f?.container).toBeUndefined();
  });

  it("flags a multi-replica workload without anti-affinity as info", () => {
    const out = analyzeReliability({
      workloads: [healthy({ hasAntiAffinity: false })],
      pdbs: [{ namespace: "default", selector: { app: "web" } }],
      hpas: [],
    });
    const f = out.find((x) => x.type === "noAntiAffinity");
    expect(f?.severity).toBe("info");
  });

  it("does not flag anti-affinity on a single-replica workload", () => {
    const out = analyzeReliability({
      workloads: [healthy({ replicas: 1, hasAntiAffinity: false })],
      pdbs: [],
      hpas: [],
    });
    expect(out.some((x) => x.type === "noAntiAffinity")).toBe(false);
  });

  it("flags a multi-replica workload with no PDB, and clears when one selects it", () => {
    const withoutPdb = analyzeReliability({ workloads: [healthy()], pdbs: [], hpas: [] });
    expect(withoutPdb.some((x) => x.type === "noPodDisruptionBudget")).toBe(true);

    const withPdb = analyzeReliability({
      workloads: [healthy()],
      pdbs: [{ namespace: "default", selector: { app: "web" } }],
      hpas: [],
    });
    expect(withPdb.some((x) => x.type === "noPodDisruptionBudget")).toBe(false);
  });

  it("does not count a PDB in another namespace or with a non-matching selector", () => {
    const out = analyzeReliability({
      workloads: [healthy()],
      pdbs: [
        { namespace: "other", selector: { app: "web" } },
        { namespace: "default", selector: { app: "api" } },
      ],
      hpas: [],
    });
    expect(out.some((x) => x.type === "noPodDisruptionBudget")).toBe(true);
  });
});

describe("sortFindings / reliabilityCounts", () => {
  it("orders a scrambled mix by severity then namespace, name, type", () => {
    // A multi-replica workload with no anti-affinity emits an info noAntiAffinity;
    // it also lacks a PDB (warning). A single-replica workload in another namespace
    // emits a warning singleReplica. Together this spans two severities and two
    // namespaces, exercising the primary key and every tie-breaker.
    const beta = healthy({ name: "beta", namespace: "zeta", hasAntiAffinity: false, labels: { app: "beta" } });
    const alpha = healthy({ name: "alpha", namespace: "alpha", replicas: 1, labels: { app: "alpha" } });
    const findings = analyzeReliability({ workloads: [beta, alpha], pdbs: [], hpas: [] });

    // Sanity check the fixture actually spans severities before asserting the order.
    expect(findings.some((f) => f.severity === "info")).toBe(true);
    expect(findings.some((f) => f.severity === "warning")).toBe(true);

    const sorted = sortFindings(findings);
    const order = sorted.map((f) => `${f.severity}:${f.namespace}/${f.name}:${f.type}`);
    expect(order).toEqual([
      // warnings first, ordered by namespace (alpha < zeta), then name, then type
      "warning:alpha/alpha:singleReplica",
      "warning:zeta/beta:noPodDisruptionBudget",
      // info sorts last regardless of namespace
      "info:zeta/beta:noAntiAffinity",
    ]);

    // Would fail against an identity sort: the engine emits the info finding for
    // `beta` before the warning singleReplica for `alpha`.
    expect(order).not.toEqual(findings.map((f) => `${f.severity}:${f.namespace}/${f.name}:${f.type}`));
  });

  it("counts warning + info findings, keeps critical 0, and dedups workloads", () => {
    // One workload with multiple findings across warning + info severities.
    const w = healthy({ replicas: 1, hasAntiAffinity: false, name: "web" });
    w.containers[0].hasLiveness = false; // warning (probe) on top of singleReplica warning
    const multi = analyzeReliability({ workloads: [w], pdbs: [], hpas: [] });
    // Add an info-severity finding from a second, multi-replica workload.
    const spread = healthy({ name: "api", hasAntiAffinity: false, labels: { app: "api" } });
    const info = analyzeReliability({ workloads: [spread], pdbs: [{ namespace: "default", selector: { app: "api" } }], hpas: [] });

    const counts = reliabilityCounts([...multi, ...info]);
    expect(counts.critical).toBe(0);
    expect(counts.warning).toBe(multi.length);
    expect(counts.info).toBe(1);
    expect(counts.total).toBe(counts.critical + counts.warning + counts.info);
    // `web` has multiple findings but counts once; plus `api` = 2 workloads.
    expect(counts.workloadsAffected).toBe(2);
  });
});
