// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { resolveNamespaceScope, useRightSizing } from "./useRightSizing";
import { useCluster } from "@/store/cluster";

vi.mock("@/lib/ws", () => ({
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}));

import { subscribe } from "@/lib/ws";

describe("resolveNamespaceScope", () => {
  it("is cluster-wide ('*') when clusterWide is set, ignoring the namespace filter", () => {
    expect(resolveNamespaceScope("kube-system", true)).toBe("*");
    expect(resolveNamespaceScope(null, true)).toBe("*");
  });

  it("uses the selected namespace when not cluster-wide", () => {
    expect(resolveNamespaceScope("kube-system", false)).toBe("kube-system");
  });

  it("falls back to '*' when no namespace is selected and not cluster-wide", () => {
    expect(resolveNamespaceScope(null, false)).toBe("*");
  });
});

describe("useRightSizing workload watches (HELM-31)", () => {
  afterEach(() => {
    cleanup();
    act(() => useCluster.getState().setNamespaceFilter(null));
    vi.mocked(subscribe).mockClear();
  });

  // Regression: switching to a specific namespace and back to "All" must NOT
  // open a namespace-scoped watch. The store slice is keyed by kind only, so a
  // scoped snapshot clobbers the shared cluster-wide slice and the panel never
  // repopulates on the way back. The watch stays "*"; namespace is a client-
  // side filter. See project_ws_store_replacekind_clobber.
  it("always watches the workload kinds cluster-wide, never a specific namespace", () => {
    act(() => useCluster.getState().setNamespaceFilter(null));
    renderHook(() => useRightSizing());

    act(() => useCluster.getState().setNamespaceFilter("kube-system"));
    act(() => useCluster.getState().setNamespaceFilter(null));

    const scopes = vi.mocked(subscribe).mock.calls.map(([, ns]) => ns);
    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes.every((ns) => ns === "*")).toBe(true);
  });
});
