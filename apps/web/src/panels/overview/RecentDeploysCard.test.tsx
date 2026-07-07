// @vitest-environment jsdom
import { describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RecentDeploysCard } from "./RecentDeploysCard";
import * as api from "@/lib/api";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const batch = {
  batchId: "b1",
  source: "compose-migration",
  appliedAt: new Date().toISOString(),
  ledgerNamespace: "shop",
  resources: [
    { kind: "Deployment", name: "web", namespace: "shop" },
    { kind: "Service", name: "web", namespace: "shop" },
  ],
};

describe("RecentDeploysCard", () => {
  test("renders a row per batch with source label + resource count", async () => {
    vi.spyOn(api, "fetchRecentDeploys").mockResolvedValue({ batches: [batch] });
    wrap(<RecentDeploysCard />);
    expect(await screen.findByText(/Compose migration/)).toBeInTheDocument();
    expect(screen.getByText(/2 resources/)).toBeInTheDocument();
    expect(screen.getByText(/shop/)).toBeInTheDocument();
  });

  test("shows an empty state when there are no batches", async () => {
    vi.spyOn(api, "fetchRecentDeploys").mockResolvedValue({ batches: [] });
    wrap(<RecentDeploysCard />);
    expect(await screen.findByText(/Nothing applied recently/i)).toBeInTheDocument();
  });

  test("Undo opens a confirm then calls undoDeploy with batchId + ledger namespace", async () => {
    vi.spyOn(api, "fetchRecentDeploys").mockResolvedValue({ batches: [batch] });
    const undo = vi.spyOn(api, "undoDeploy").mockResolvedValue({ ok: true, results: [] });
    wrap(<RecentDeploysCard />);
    fireEvent.click(await screen.findByRole("button", { name: /undo/i }));
    fireEvent.click(await screen.findByRole("button", { name: /delete/i }));
    await waitFor(() => expect(undo).toHaveBeenCalledWith("b1", "shop"));
  });
});
