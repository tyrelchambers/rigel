// apps/web/src/panels/assistant/audits/auditPrompt.test.ts
import { describe, it, expect } from "vitest";
import { buildReliabilityAuditPrompt } from "./auditPrompt";
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
});
