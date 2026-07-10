// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

vi.mock("@/lib/ws", () => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }));

import { useCluster } from "@/store/cluster";
import PluginsPanel from "./PluginsPanel";

afterEach(cleanup);

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <PluginsPanel />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PluginsPanel", () => {
  it("lists the four add-ons", () => {
    useCluster.setState({ resources: {} as never });
    renderPanel();
    expect(screen.getByText("Metrics Server")).toBeTruthy();
    expect(screen.getByText("Descheduler")).toBeTruthy();
    expect(screen.getByText("cert-manager")).toBeTruthy();
    expect(screen.getByText("ingress-nginx")).toBeTruthy();
  });

  it("marks an add-on Installed when its workload is present in the store", () => {
    useCluster.setState({
      resources: {
        deployments: { "kube-system/metrics-server": { metadata: { name: "metrics-server", namespace: "kube-system" } } },
      } as never,
    });
    renderPanel();
    expect(screen.getAllByText(/installed/i).length).toBeGreaterThan(0);
  });
});
