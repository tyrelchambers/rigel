import { describe, expect, it, vi } from "vitest";
import { diagnosePrompt, issueFixAction, openIssueSubject } from "./issueActions";
import { issueFingerprint, type Issue } from "@rigel/k8s/src/issues/types";

const issue: Issue = (() => {
  const base: Issue = {
    fingerprint: "",
    rule: "ingressBackendPortMissing",
    title: "Ingress backend missing",
    category: "networking",
    severity: "critical",
    subject: { kind: "Ingress", namespace: "default", name: "web" },
    cause: "Missing backend Service port",
    whatsWrong: 'Service "web-svc" does not expose port "8000", so traffic to this route is dropped.',
    nextStep: 'Point the backend at a port the Service exposes, or add port "8000" to the Service.',
    evidence: 'defaultBackend targets Service "web-svc" port "8000" which the Service does not expose',
    related: [{ kind: "Service", namespace: "default", name: "web-svc" }],
    source: "cluster",
  };
  return { ...base, fingerprint: issueFingerprint(base) };
})();

describe("diagnosePrompt", () => {
  it("names the subject, the cause and the evidence", () => {
    const p = diagnosePrompt(issue);
    expect(p).toContain("default/web");
    expect(p).toContain("Ingress");
    expect(p).toContain("Missing backend Service port");
    expect(p).toContain("does not expose port");
  });

  it("contains no em-dash", () => {
    expect(diagnosePrompt(issue)).not.toContain("—");
  });

  it("names a cluster-scoped subject without a leading slash", () => {
    const node: Issue = {
      ...issue,
      rule: "nodeNotReady",
      subject: { kind: "Node", namespace: "", name: "node-1" },
      related: [],
      evidence: undefined,
    };
    const p = diagnosePrompt(node);
    expect(p).toContain("node-1");
    expect(p).not.toContain("/node-1");
  });
});

describe("issueFixAction", () => {
  it("is undefined when the issue carries no fix", () => {
    expect(issueFixAction(issue)).toBeUndefined();
  });

  it("renders the fix as a kubectl command line", () => {
    const withFix: Issue = {
      ...issue,
      fix: { label: "Restart rollout", destructive: false, command: ["rollout", "restart", "deployment/web", "-n", "default"] },
    };
    expect(issueFixAction(withFix)).toEqual({
      label: "Restart rollout",
      destructive: false,
      command: ["rollout", "restart", "deployment/web", "-n", "default"],
      commandLine: "kubectl rollout restart deployment/web -n default",
    });
  });
});

describe("openIssueSubject", () => {
  it("routes a known subject kind to its panel", () => {
    const navigate = vi.fn();
    openIssueSubject(navigate, issue);
    expect(navigate).toHaveBeenCalledWith("/ingresses");
  });

  it("is a no-op for a kind with no panel", () => {
    const navigate = vi.fn();
    openIssueSubject(navigate, { ...issue, subject: { kind: "APIService", namespace: "", name: "v1.metrics" } });
    expect(navigate).not.toHaveBeenCalled();
  });
});
