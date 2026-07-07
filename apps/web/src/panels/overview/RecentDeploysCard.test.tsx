// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RecentDeploysCard } from "./RecentDeploysCard";

afterEach(() => vi.restoreAllMocks());

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

function mockFetch(batches: unknown[]) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const body = url === "/api/deployments/undo" ? { ok: true, results: [] } : { batches };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  });
}

describe("RecentDeploysCard", () => {
  test("renders a row per batch with source label + resource count", async () => {
    mockFetch([batch]);
    wrap(<RecentDeploysCard />);
    expect(await screen.findByText(/Compose migration/)).toBeInTheDocument();
    expect(screen.getByText(/2 resources/)).toBeInTheDocument();
    expect(screen.getByText(/shop/)).toBeInTheDocument();
  });

  test("shows an empty state when there are no batches", async () => {
    mockFetch([]);
    wrap(<RecentDeploysCard />);
    expect(await screen.findByText(/Nothing applied recently/i)).toBeInTheDocument();
  });

  test("Undo opens a confirm then POSTs the batchId + ledger namespace", async () => {
    const f = mockFetch([batch]);
    wrap(<RecentDeploysCard />);
    fireEvent.click(await screen.findByRole("button", { name: /undo/i }));
    fireEvent.click(await screen.findByRole("button", { name: /delete/i }));
    await waitFor(() => {
      const call = f.mock.calls.find(([u]) => u === "/api/deployments/undo");
      expect(call).toBeTruthy();
      expect(JSON.parse(call![1]!.body as string)).toEqual({ batchId: "b1", namespace: "shop" });
    });
  });
});
