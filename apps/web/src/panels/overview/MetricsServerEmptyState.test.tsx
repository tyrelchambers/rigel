// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MetricsServerEmptyState } from "./MetricsServerEmptyState";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderEmptyState(available = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MetricsServerEmptyState available={available} />
    </QueryClientProvider>,
  );
}

test("renders the explanation and an enabled Install button when metrics-server is absent", () => {
  renderEmptyState();
  expect(screen.getByText(/live node metrics aren't available/i)).toBeTruthy();
  const btn = screen.getByRole("button", { name: /install metrics-server/i });
  expect((btn as HTMLButtonElement).disabled).toBe(false);
});

test("shows a neutral waiting note with no install button when metrics-server is installed but has no node data yet", () => {
  renderEmptyState(true);
  expect(screen.getByText(/hasn't reported node data yet/i)).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});

test("clicking Install POSTs to the install endpoint and shows success", async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  vi.stubGlobal("fetch", fetchMock);
  renderEmptyState();

  fireEvent.click(screen.getByRole("button", { name: /install metrics-server/i }));

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith("/api/install/metrics-server", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  await waitFor(() => expect(screen.getByRole("button", { name: /installed/i })).toBeTruthy());
});

test("surfaces the error when the install fails", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: false, text: async () => "boom" });
  vi.stubGlobal("fetch", fetchMock);
  renderEmptyState();

  fireEvent.click(screen.getByRole("button", { name: /install metrics-server/i }));

  await waitFor(() => expect(screen.getByText("boom")).toBeTruthy());
});
