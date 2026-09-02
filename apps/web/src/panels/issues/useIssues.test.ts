// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { ISSUE_KINDS, buildIssueInput, useIssues } from "./useIssues";
import { useCluster } from "@/store/cluster";
import type { IssueMutes } from "@rigel/k8s/src/issues/mutes";

vi.mock("@/lib/ws", () => ({
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}));

const stored = vi.hoisted(() => ({ mutes: {} as IssueMutes }));
vi.mock("./useIssueMutes", () => ({
  useIssueMutes: () => ({ mutes: stored.mutes, mute: vi.fn(), unmute: vi.fn(), saving: false }),
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
    stored.mutes = {};
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

describe("useIssues mutes", () => {
  const pod = {
    metadata: { name: "api-0", namespace: "default" },
    spec: { containers: [{ name: "api" }] },
    status: {
      phase: "Running",
      containerStatuses: [
        {
          name: "api",
          restartCount: 4,
          state: { waiting: { reason: "CrashLoopBackOff", message: "back-off 5m0s" } },
        },
      ],
    },
  };

  afterEach(() => {
    cleanup();
    act(() => useCluster.getState().clearKind("pods"));
    stored.mutes = {};
  });

  it("keeps a muted issue out of issues and groups but returns it in muted", () => {
    act(() => useCluster.getState().upsert("pods", "default/api-0", pod));
    const first = renderHook(() => useIssues());
    const fingerprint = first.result.current.issues[0]?.fingerprint;
    expect(fingerprint).toBeTruthy();
    cleanup();

    stored.mutes = { [fingerprint!]: { until: null } };
    const { result } = renderHook(() => useIssues());
    expect(result.current.issues).toEqual([]);
    expect(result.current.groups).toEqual([]);
    expect(result.current.muted.map((i) => i.fingerprint)).toEqual([fingerprint]);
  });

  it("leaves an issue whose snooze has expired in the live list", () => {
    act(() => useCluster.getState().upsert("pods", "default/api-0", pod));
    const first = renderHook(() => useIssues());
    const fingerprint = first.result.current.issues[0]!.fingerprint;
    cleanup();

    stored.mutes = { [fingerprint]: { until: "2000-01-01T00:00:00.000Z" } };
    const { result } = renderHook(() => useIssues());
    expect(result.current.issues.map((i) => i.fingerprint)).toEqual([fingerprint]);
    expect(result.current.muted).toEqual([]);
  });
});
