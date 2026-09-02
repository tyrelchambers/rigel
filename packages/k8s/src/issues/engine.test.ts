import { describe, it, expect } from "vitest";
import { rollUpIssues, sortIssues, detectIssues } from "./engine";
import { issueFingerprint, type Issue } from "./types";

function make(over: Partial<Issue>): Issue {
  const base: Issue = {
    fingerprint: "",
    rule: "webhookBackendMissing",
    title: "Webhook backend down",
    category: "controlPlane",
    severity: "critical",
    subject: { kind: "ValidatingWebhookConfiguration", namespace: "", name: "a" },
    cause: "Missing webhook backend Service",
    whatsWrong: "",
    nextStep: "",
    related: [],
    source: "cluster",
    ...over,
  };
  return { ...base, fingerprint: issueFingerprint(base) };
}

describe("sortIssues", () => {
  it("orders critical before warning before info", () => {
    const out = sortIssues([
      make({ severity: "info", subject: { kind: "PV", namespace: "", name: "c" } }),
      make({ severity: "critical", subject: { kind: "PV", namespace: "", name: "a" } }),
      make({ severity: "warning", subject: { kind: "PV", namespace: "", name: "b" } }),
    ]);
    expect(out.map((i) => i.severity)).toEqual(["critical", "warning", "info"]);
  });

  it("breaks ties by oldest onset first", () => {
    const out = sortIssues([
      make({ subject: { kind: "PV", namespace: "", name: "new" }, onsetAt: "2026-09-01T00:00:00Z" }),
      make({ subject: { kind: "PV", namespace: "", name: "old" }, onsetAt: "2026-01-01T00:00:00Z" }),
    ]);
    expect(out[0].subject.name).toBe("old");
  });
});

describe("rollUpIssues", () => {
  it("groups issues sharing rule and cause", () => {
    const groups = rollUpIssues([
      make({ subject: { kind: "ValidatingWebhookConfiguration", namespace: "", name: "a" } }),
      make({ subject: { kind: "ValidatingWebhookConfiguration", namespace: "", name: "b" } }),
      make({ subject: { kind: "ValidatingWebhookConfiguration", namespace: "", name: "c" } }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(3);
    expect(groups[0].lead.subject.name).toBe("a");
  });

  it("keeps a lone issue as a group of one", () => {
    const groups = rollUpIssues([make({})]);
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(1);
  });

  it("does not group across different causes", () => {
    const groups = rollUpIssues([make({ cause: "one" }), make({ cause: "two" })]);
    expect(groups).toHaveLength(2);
  });
});

describe("detectIssues", () => {
  it("tolerates a completely empty input", () => {
    expect(detectIssues({})).toEqual([]);
  });

  it("tolerates absent kinds without inventing issues", () => {
    expect(detectIssues({ pods: [] })).toEqual([]);
  });
});
