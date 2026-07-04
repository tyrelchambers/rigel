// apps/web/src/panels/assistant/audits/auditPrompt.test.ts
import { describe, it, expect } from "vitest";
import { buildReliabilityAuditPrompt, SEED_CAP } from "./auditPrompt";
import type { ReliabilityFinding } from "@rigel/k8s";

const finding: ReliabilityFinding = {
  type: "singleReplica",
  severity: "warning",
  kind: "Deployment",
  name: "web",
  namespace: "default",
  rationale: "Runs a single replica.",
  fix: "Scale to 2+.",
};

/** Build N distinct findings of a given type/severity (unique names). */
function many(n: number, over: Partial<ReliabilityFinding> = {}): ReliabilityFinding[] {
  return Array.from({ length: n }, (_, i) => ({
    ...finding,
    name: `w${i}`,
    ...over,
  }));
}

describe("buildReliabilityAuditPrompt", () => {
  it("embeds the findings JSON and asks for severity grouping + action blocks", () => {
    const p = buildReliabilityAuditPrompt([finding]);
    expect(p).toContain("Reliability");
    expect(p).toContain("grouped by severity");
    expect(p).toContain("```action");
    expect(p).toContain('"type": "singleReplica"');
  });

  it("uses a no-issues prompt when there are no findings", () => {
    const p = buildReliabilityAuditPrompt([]);
    expect(p).toContain("no reliability issues");
    expect(p).not.toContain("```json");
  });

  it("seeds compact rows without the constant rationale/fix strings", () => {
    const p = buildReliabilityAuditPrompt([finding]);
    // The seeded JSON must not carry the per-finding rationale/fix (redundant bloat).
    expect(p).not.toContain("rationale");
    expect(p).not.toContain("Scale to 2+");
    // But it keeps the identifying fields.
    expect(p).toContain('"namespace": "default"');
    expect(p).toContain('"name": "web"');
  });

  it("reports the total count and workloads affected", () => {
    const p = buildReliabilityAuditPrompt([finding]);
    expect(p).toContain("Found 1 issue across 1 workload");
  });

  it("caps seeded rows at SEED_CAP and summarizes the overflow by severity and type", () => {
    const findings = [
      ...many(SEED_CAP + 5, { type: "singleReplica", severity: "warning" }),
      ...many(3, { type: "noAntiAffinity", severity: "info", name: "aa" }),
    ];
    const p = buildReliabilityAuditPrompt(findings);
    // Only SEED_CAP rows appear in the JSON payload.
    const rowCount = (p.match(/"type":/g) ?? []).length;
    expect(rowCount).toBe(SEED_CAP);
    // The long tail is summarized, not dumped.
    expect(p).toContain(`Not shown: ${findings.length - SEED_CAP} more`);
    expect(p).toContain("by type:");
    expect(p).toContain('highest-severity findings');
  });

  it("omits the overflow note when everything fits under the cap", () => {
    const p = buildReliabilityAuditPrompt(many(3));
    expect(p).not.toContain("Not shown:");
    expect(p).toContain("Findings are below.");
  });
});
