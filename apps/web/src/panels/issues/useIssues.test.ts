// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { ISSUE_KINDS, buildIssueInput, useIssues } from "./useIssues";
import { useCluster } from "@/store/cluster";

vi.mock("@/lib/ws", () => ({
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}));

import { subscribe } from "@/lib/ws";

describe("buildIssueInput", () => {
  it("omits kinds absent from the store rather than emptying them", () => {
    const input = buildIssueInput({ pods: {} });
    expect(input.pods).toEqual([]);
    expect(input.configmaps).toBeUndefined();
    expect(input.services).toBeUndefined();
  });

  it("maps store objects into arrays", () => {
    const pod = { metadata: { name: "a", namespace: "default" } };
    expect(buildIssueInput({ pods: { "default/a": pod } }).pods).toEqual([pod]);
  });

  it("maps the cert-manager CRD kinds onto their short field names", () => {
    const cert = { metadata: { name: "c", namespace: "default" } };
    const input = buildIssueInput({ "certificates.cert-manager.io": { "default/c": cert } });
    expect(input.certificates).toEqual([cert]);
  });

  it("omits a kind the connection is forbidden from watching, even though its slice is empty", () => {
    const input = buildIssueInput(
      { pods: { "default/a": { metadata: { name: "a", namespace: "default" } } }, secrets: {} },
      { secrets: { status: "forbidden" } },
    );
    expect(input.pods).toHaveLength(1);
    expect(input.secrets).toBeUndefined();
  });

  it("maps every watched kind onto a distinct input field", () => {
    const resources = Object.fromEntries(
      ISSUE_KINDS.map((k) => [k, { "default/x": { metadata: { name: "x", namespace: "default" } } }]),
    );
    const populated = Object.values(buildIssueInput(resources)).filter((v) => v !== undefined);
    expect(populated).toHaveLength(ISSUE_KINDS.length);
  });
});

describe("useIssues watches", () => {
  afterEach(() => {
    cleanup();
    act(() => useCluster.getState().setNamespaceFilter(null));
    vi.mocked(subscribe).mockClear();
  });

  it("surfaces an agent incident decoded from the assistant-state ConfigMap", () => {
    act(() =>
      useCluster.getState().upsert("configmaps", "rigel/assistant-state", {
        metadata: { name: "assistant-state", namespace: "rigel" },
        data: {
          "state.json": JSON.stringify({
            queue: [
              {
                at: "2026-09-02T10:00:00.000Z",
                incident: "default/worker-0: panic",
                suggestion: "Inspect the worker logs",
                reason: "No safe automatic remediation",
                fingerprint: "loggedError|default|worker-0|PanicSignature",
              },
            ],
          }),
        },
      }),
    );
    const { result } = renderHook(() => useIssues());
    expect(result.current.issues.map((i) => i.source)).toEqual(["agent"]);
    act(() => useCluster.getState().clearKind("configmaps"));
  });

  it("subscribes every issue kind cluster-wide, never a specific namespace", () => {
    act(() => useCluster.getState().setNamespaceFilter("kube-system"));
    renderHook(() => useIssues());

    const calls = vi.mocked(subscribe).mock.calls;
    expect(calls.map((c) => c[0]).sort()).toEqual([...ISSUE_KINDS].sort());
    for (const call of calls) expect(call[1]).toBe("*");
  });
});
