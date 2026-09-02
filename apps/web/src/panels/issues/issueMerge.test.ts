import { describe, expect, it } from "vitest";
import { mergeAgentIssues } from "./issueMerge";
import { issueFingerprint, type Issue } from "@rigel/k8s/src/issues/types";

function clusterIssue(): Issue {
  const base: Issue = {
    fingerprint: "",
    rule: "crashLoopBackOff",
    title: "Crash loop",
    category: "runtime",
    severity: "critical",
    subject: { kind: "Pod", namespace: "default", name: "api-0" },
    cause: "Container is restarting in a crash loop",
    whatsWrong: "",
    nextStep: "",
    related: [],
    source: "cluster",
  };
  return { ...base, fingerprint: issueFingerprint(base) };
}

describe("mergeAgentIssues", () => {
  it("returns the cluster issues unchanged when there is no agent state", () => {
    const c = [clusterIssue()];
    expect(mergeAgentIssues(c, undefined)).toEqual(c);
    expect(mergeAgentIssues(c, null)).toEqual(c);
    expect(mergeAgentIssues(c, { queue: [] })).toEqual(c);
  });

  it("drops an agent incident already detected client-side", () => {
    const out = mergeAgentIssues(
      [clusterIssue()],
      {
        queue: [
          {
            at: "2026-09-02T10:00:00.000Z",
            incident: "default/api-0: CrashLoopBackOff",
            suggestion: "kubectl rollout restart deployment/api -n default",
            reason: "Destructive, needs a human",
            fingerprint: "unhealthyPod|default|api-0|CrashLoopBackOff",
          },
        ],
      },
    );
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("cluster");
  });

  it("keeps an agent-only incident and marks its source", () => {
    const out = mergeAgentIssues([], {
      queue: [
        {
          at: "2026-09-02T10:00:00.000Z",
          incident: "default/worker-0: panic: runtime error",
          suggestion: "Inspect the worker logs",
          reason: "No safe automatic remediation",
          fingerprint: "loggedError|default|worker-0|PanicSignature",
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("agent");
    expect(out[0].rule).toBe("agentIncident");
    expect(out[0].subject).toEqual({ kind: "Pod", namespace: "default", name: "worker-0" });
    expect(out[0].cause).toBe("PanicSignature");
    expect(out[0].onsetAt).toBe("2026-09-02T10:00:00.000Z");
    expect(out[0].fingerprint).toBe(issueFingerprint(out[0]));
  });

  it("keeps a degraded-deployment incident the client rules did not detect", () => {
    const out = mergeAgentIssues([clusterIssue()], {
      queue: [
        {
          at: "2026-09-02T10:00:00.000Z",
          incident: "default/api: Degraded",
          suggestion: "kubectl describe deployment/api -n default",
          reason: "RBAC denied",
          fingerprint: "degradedDeployment|default|api|Degraded",
        },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out.map((i) => i.subject.kind)).toContain("Deployment");
  });

  it("skips a queue entry with no parseable fingerprint", () => {
    const out = mergeAgentIssues([], {
      queue: [
        { at: "t", incident: "something broke", suggestion: "s", reason: "r" },
        { at: "t", incident: "something broke", suggestion: "s", reason: "r", fingerprint: "garbage" },
      ],
    });
    expect(out).toEqual([]);
  });
});
