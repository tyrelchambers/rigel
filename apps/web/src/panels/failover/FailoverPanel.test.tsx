// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import FailoverPanel from "./FailoverPanel";

vi.mock("@/lib/api", () => ({
  useFailoverConfig: () => ({
    data: {
      configured: false,
      provider: "digitalocean",
      tokenSet: false,
      spacesKeySet: false,
      spacesSecretSet: false,
      region: "tor1",
      nodeSize: "s-4vcpu-8gb",
      nodeCount: 1,
      cluster: { context: "home", namespace: "rigel", secret: "rigel-user-config", state: "ok" },
    },
  }),
  useFailoverState: () => ({ data: {} }),
  useFailoverPlan: () => ({ data: undefined, mutate: vi.fn(), isPending: false }),
  useFailoverRun: () => ({ data: undefined, mutate: vi.fn(), isPending: false, error: null }),
  useFailoverEdgeConfirm: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useFailoverScaleHome: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useFailoverRestore: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

describe("FailoverPanel", () => {
  it("sends an unconfigured cluster to Settings", () => {
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <FailoverPanel />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText(/configure a digitalocean destination first/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open failover settings/i })).toHaveAttribute("href", "/settings?tab=failover");
  });
});
