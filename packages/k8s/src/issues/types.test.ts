import { describe, it, expect } from "vitest";
import { issueFingerprint, type Issue } from "./types";

function issue(over: Partial<Issue> = {}): Issue {
  return {
    fingerprint: "",
    rule: "crashLoopBackOff",
    title: "Crash loop",
    category: "runtime",
    severity: "critical",
    subject: { kind: "Pod", namespace: "default", name: "api-0" },
    cause: "Container keeps restarting",
    whatsWrong: "",
    nextStep: "",
    related: [],
    source: "cluster",
    ...over,
  };
}

describe("issueFingerprint", () => {
  it("is stable across volatile fields", () => {
    const a = issueFingerprint(issue({ onsetAt: "2026-01-01T00:00:00Z" }));
    const b = issueFingerprint(issue({ onsetAt: "2026-09-02T00:00:00Z" }));
    expect(a).toBe(b);
  });

  it("separates different subjects", () => {
    const a = issueFingerprint(issue());
    const b = issueFingerprint(issue({ subject: { kind: "Pod", namespace: "default", name: "api-1" } }));
    expect(a).not.toBe(b);
  });

  it("separates different causes on the same subject", () => {
    const a = issueFingerprint(issue({ cause: "one" }));
    const b = issueFingerprint(issue({ cause: "two" }));
    expect(a).not.toBe(b);
  });
});
