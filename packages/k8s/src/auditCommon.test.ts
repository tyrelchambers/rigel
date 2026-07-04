// packages/k8s/src/auditCommon.test.ts
import { describe, it, expect } from "vitest";
import { sortFindings, auditCounts, type AuditFinding } from "./auditCommon";

/** A minimal finding builder — spread + override per test. */
function finding(over: Partial<AuditFinding> = {}): AuditFinding {
  return {
    type: "someCheck",
    severity: "warning",
    kind: "Deployment",
    name: "web",
    namespace: "default",
    rationale: "because",
    fix: "fix it",
    ...over,
  };
}

describe("sortFindings", () => {
  it("orders a scrambled mix by severity then namespace, name, type", () => {
    const infoZeta = finding({ type: "noAntiAffinity", severity: "info", namespace: "zeta", name: "beta" });
    const warningAlpha = finding({ type: "singleReplica", severity: "warning", namespace: "alpha", name: "alpha" });
    const warningZeta = finding({ type: "noPodDisruptionBudget", severity: "warning", namespace: "zeta", name: "beta" });
    // Scrambled input order (info first) so this fails against an identity sort.
    const findings = [infoZeta, warningAlpha, warningZeta];

    const sorted = sortFindings(findings);
    const order = sorted.map((f) => `${f.severity}:${f.namespace}/${f.name}:${f.type}`);
    expect(order).toEqual([
      "warning:alpha/alpha:singleReplica",
      "warning:zeta/beta:noPodDisruptionBudget",
      "info:zeta/beta:noAntiAffinity",
    ]);

    // Would fail against an identity sort: info sorts last, but appears first in input.
    expect(order).not.toEqual(findings.map((f) => `${f.severity}:${f.namespace}/${f.name}:${f.type}`));
  });

  it("tie-breaks by type when severity, namespace, and name all match", () => {
    const b = finding({ type: "bCheck" });
    const a = finding({ type: "aCheck" });
    const sorted = sortFindings([b, a]);
    expect(sorted.map((f) => f.type)).toEqual(["aCheck", "bCheck"]);
  });
});

describe("auditCounts", () => {
  it("counts each severity bucket and totals them", () => {
    const findings = [
      finding({ severity: "critical", name: "a" }),
      finding({ severity: "warning", name: "b" }),
      finding({ severity: "warning", name: "c" }),
      finding({ severity: "info", name: "d" }),
    ];
    const counts = auditCounts(findings);
    expect(counts.critical).toBe(1);
    expect(counts.warning).toBe(2);
    expect(counts.info).toBe(1);
    expect(counts.total).toBe(4);
  });

  it("dedups workloadsAffected when one workload has multiple findings", () => {
    const findings = [
      finding({ name: "web", namespace: "default", type: "noLivenessProbe" }),
      finding({ name: "web", namespace: "default", type: "noReadinessProbe" }),
      finding({ name: "api", namespace: "default", type: "singleReplica" }),
    ];
    const counts = auditCounts(findings);
    expect(counts.total).toBe(3);
    expect(counts.workloadsAffected).toBe(2);
  });

  it("returns all-zero counts for an empty finding set", () => {
    const counts = auditCounts([]);
    expect(counts).toEqual({ critical: 0, warning: 0, info: 0, total: 0, workloadsAffected: 0 });
  });
});
