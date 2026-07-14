// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const refetch = vi.fn();
vi.mock("@/lib/api", () => ({
  useClusterTools: () => ({
    data: { dockerRunning: true, kind: true, k3d: false },
    refetch,
    isFetching: false,
  }),
}));

const sendClusterCreate = vi.fn();
const sendClusterStop = vi.fn();
vi.mock("@/lib/ws", () => ({
  sendClusterCreate: (...a: unknown[]) => sendClusterCreate(...a),
  sendClusterStop: (...a: unknown[]) => sendClusterStop(...a),
  onClusterEvent: () => () => {},
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

beforeEach(() => {
  refetch.mockReset();
  sendClusterCreate.mockReset();
  sendClusterStop.mockReset();
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
});
