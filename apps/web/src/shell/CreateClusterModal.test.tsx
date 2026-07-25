// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const refetch = vi.fn();
vi.mock("@/lib/api", () => ({
  useClusterTools: () => ({
    data: { dockerRunning: true, kind: true, k3d: false },
    refetch,
    isFetching: false,
  }),
}));

type ClusterListener = (e: Record<string, unknown>) => void;
const clusterListeners = new Set<ClusterListener>();
const sendClusterCreate = vi.fn();
const sendClusterStop = vi.fn();
vi.mock("@/lib/ws", () => ({
  sendClusterCreate: (...a: unknown[]) => sendClusterCreate(...a),
  sendClusterStop: (...a: unknown[]) => sendClusterStop(...a),
  onClusterEvent: (cb: ClusterListener) => {
    clusterListeners.add(cb);
    return () => clusterListeners.delete(cb);
  },
}));

import { CreateClusterModal } from "./CreateClusterModal";

function wrap(onOpenChange: (o: boolean) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CreateClusterModal open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
}

function emit(e: Record<string, unknown>) {
  act(() => { for (const cb of [...clusterListeners]) cb(e); });
}

function startCreate() {
  fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "dev" } });
  fireEvent.click(screen.getByRole("button", { name: /^create cluster$/i }));
}

beforeEach(() => {
  Element.prototype.scrollTo = vi.fn();
  refetch.mockReset();
  sendClusterCreate.mockReset();
  sendClusterStop.mockReset();
  clusterListeners.clear();
});

describe("CreateClusterModal", () => {
  it("offers a Cancel button that closes the window without creating", () => {
    const onOpenChange = vi.fn();
    wrap(onOpenChange);
    const cancel = screen.getByRole("button", { name: /^cancel$/i });
    fireEvent.click(cancel);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(sendClusterCreate).not.toHaveBeenCalled();
  });

  it("stops the in-flight create when dismissed mid-create", () => {
    wrap(vi.fn());
    startCreate();
    expect(sendClusterCreate).toHaveBeenCalledWith({ tool: "kind", name: "dev", version: "default" });

    emit({ type: "cluster.progress", line: "Preparing nodes" });
    expect(screen.getByText(/Preparing nodes/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(sendClusterStop).toHaveBeenCalledTimes(1);
  });

  it("stops nothing when dismissed while idle", () => {
    wrap(vi.fn());
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(sendClusterStop).not.toHaveBeenCalled();
  });

  it("stops nothing when dismissed after the create already failed", () => {
    wrap(vi.fn());
    startCreate();
    emit({ type: "cluster.error", message: "docker not running" });

    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(sendClusterStop).not.toHaveBeenCalled();
  });
});
