// @vitest-environment jsdom
//
// ClusterRail reconciliation tests. The key behavior under test:
//   1. On first load (activeContext null) → initContext is called with the
//      kubeconfig-active context.
//   2. When activeContext is valid (present in contexts) → no spurious switch.
//   3. When activeContext is gone (disconnected/deleted) → switchCluster is
//      called with a valid fallback (the kubeconfig-active one, else first).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ClusterContext } from "@/lib/api";

// ---- WS stubs -----------------------------------------------------------------
const initContext = vi.fn();
const switchCluster = vi.fn();
vi.mock("@/lib/ws", () => ({
  initContext: (...args: unknown[]) => initContext(...args),
  switchCluster: (...args: unknown[]) => switchCluster(...args),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  onChatEvent: () => () => {},
  onClusterEvent: () => () => {},
}));

// ---- API stubs ----------------------------------------------------------------
// These are vi.fn()s we'll reconfigure per-test via mockReturnValue.
const mockUseContexts = vi.fn();
const mockUseDeleteCluster = vi.fn();
const mockUseDisconnectCluster = vi.fn();
const mockUseClusterHealth = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    useContexts: (...args: unknown[]) => mockUseContexts(...args),
    useDeleteCluster: (...args: unknown[]) => mockUseDeleteCluster(...args),
    useDisconnectCluster: (...args: unknown[]) => mockUseDisconnectCluster(...args),
    useClusterHealth: (...args: unknown[]) => mockUseClusterHealth(...args),
  };
});

// ---- Store stubs ---------------------------------------------------------------
import { useCluster } from "@/store/cluster";

// ---- Component under test -----------------------------------------------------
// Import AFTER mocks are in place.
import { ClusterRail } from "./ClusterRail";

// ---- Test helpers -------------------------------------------------------------
const noopMutation = { mutate: vi.fn(), isPending: false };

/** Minimal ClusterContext fixture. */
function ctx(name: string, active = false): ClusterContext {
  return { name, cluster: name, server: `https://${name}`, active };
}

function renderRail() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ClusterRail />
    </QueryClientProvider>,
  );
}

describe("ClusterRail reconciliation effect", () => {
  beforeEach(() => {
    initContext.mockClear();
    switchCluster.mockClear();
    // Reset store to pristine (no active context).
    useCluster.setState({ activeContext: null, resources: {} });
    // Default mutation stubs.
    mockUseDeleteCluster.mockReturnValue(noopMutation);
    mockUseDisconnectCluster.mockReturnValue(noopMutation);
    mockUseClusterHealth.mockReturnValue({ data: null });
    // clusterIconStore reads localStorage; clear to avoid cross-test bleed.
    localStorage.clear();
  });

  it("calls initContext on first load when activeContext is null", async () => {
    mockUseContexts.mockReturnValue({
      data: [ctx("prod", true), ctx("staging")],
    });

    renderRail();

    await waitFor(() => expect(initContext).toHaveBeenCalledWith("prod"));
    expect(switchCluster).not.toHaveBeenCalled();
  });

  it("prefers the kubeconfig-active context as the fallback on first load", async () => {
    // "staging" is the kubeconfig-active one, even though it's second.
    mockUseContexts.mockReturnValue({
      data: [ctx("prod", false), ctx("staging", true)],
    });

    renderRail();

    await waitFor(() => expect(initContext).toHaveBeenCalledWith("staging"));
    expect(switchCluster).not.toHaveBeenCalled();
  });

  it("does NOT call switchCluster when the active context is present in the list", async () => {
    useCluster.setState({ activeContext: "prod" });
    mockUseContexts.mockReturnValue({
      data: [ctx("prod", true), ctx("staging")],
    });

    renderRail();

    // Give the effect a tick to fire.
    await waitFor(() => expect(initContext).not.toHaveBeenCalled());
    expect(switchCluster).not.toHaveBeenCalled();
  });

  it("re-points the active context when it disappears from the contexts list", async () => {
    // Simulate a context that was just disconnected: "gone" is no longer in the
    // list, but the store still points at it.
    useCluster.setState({ activeContext: "gone" });
    mockUseContexts.mockReturnValue({
      data: [ctx("local", true)],
    });

    renderRail();

    await waitFor(() => expect(switchCluster).toHaveBeenCalledWith("local"));
    expect(initContext).not.toHaveBeenCalled();
  });

  it("falls back to the first context when none is kubeconfig-active after removal", async () => {
    useCluster.setState({ activeContext: "deleted-ctx" });
    // Neither context has active: true.
    mockUseContexts.mockReturnValue({
      data: [ctx("cluster-a", false), ctx("cluster-b", false)],
    });

    renderRail();

    // Should fall back to the first entry.
    await waitFor(() => expect(switchCluster).toHaveBeenCalledWith("cluster-a"));
  });

  it("does not render when contexts list is empty", () => {
    useCluster.setState({ activeContext: null });
    mockUseContexts.mockReturnValue({ data: [] });

    const { container } = renderRail();

    expect(container.firstChild).toBeNull();
    expect(initContext).not.toHaveBeenCalled();
    expect(switchCluster).not.toHaveBeenCalled();
  });
});
