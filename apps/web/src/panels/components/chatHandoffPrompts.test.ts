import { describe, it, expect } from "vitest";
import { buildWarningInvestigationPrompt } from "./chatHandoffPrompts";
import type { K8sEvent } from "@/panels/events/types";

function evt(partial: Partial<K8sEvent>): K8sEvent {
  return {
    metadata: { name: "e1", uid: "u1" },
    type: "Warning",
    reason: null,
    message: null,
    count: null,
    firstTimestamp: null,
    lastTimestamp: null,
    involvedObject: null,
    ...partial,
  } as K8sEvent;
}

describe("buildWarningInvestigationPrompt", () => {
  it("includes reason, kind/name/namespace, and message", () => {
    const p = buildWarningInvestigationPrompt([
      evt({
        reason: "Unhealthy",
        message: "Readiness probe failed",
        involvedObject: { kind: "Pod", name: "api-1", namespace: "prod", uid: "x" },
      }),
    ]);
    expect(p).toContain("Reason: Unhealthy");
    expect(p).toContain("Pod api-1 in namespace prod");
    expect(p).toContain('Message: "Readiness probe failed"');
    expect(p).toContain("read-only kubectl");
  });

  it("defaults a missing namespace to default", () => {
    const p = buildWarningInvestigationPrompt([
      evt({ reason: "BackOff", involvedObject: { kind: "Pod", name: "api-1", namespace: null, uid: "x" } }),
    ]);
    expect(p).toContain("in namespace default");
  });

  it("omits the Message clause when there is no message", () => {
    const p = buildWarningInvestigationPrompt([
      evt({ reason: "FailedMount", involvedObject: { kind: "Pod", name: "api-1", namespace: "prod", uid: "x" } }),
    ]);
    expect(p).not.toContain("Message:");
  });

  it("falls back gracefully when the involved object is missing", () => {
    const p = buildWarningInvestigationPrompt([evt({ reason: "Warning" })]);
    expect(p).toContain("a resource in namespace default");
  });

  it("lists every warning, numbered, when given several", () => {
    const p = buildWarningInvestigationPrompt([
      evt({ reason: "BackOff", involvedObject: { kind: "Pod", name: "api-1", namespace: "prod", uid: "x" } }),
      evt({ reason: "FailedMount", message: "volume not found", involvedObject: { kind: "Pod", name: "db-0", namespace: "data", uid: "y" } }),
    ]);
    expect(p).toContain("these 2 recent Kubernetes warnings");
    expect(p).toContain("1. Reason: BackOff. Resource: Pod api-1 in namespace prod.");
    expect(p).toContain('2. Reason: FailedMount. Resource: Pod db-0 in namespace data. Message: "volume not found".');
    expect(p).toContain("read-only kubectl");
  });
});
