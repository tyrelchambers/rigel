// @vitest-environment jsdom
import { useState } from "react";
import { test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockUseEntitlement = vi.fn(() => ({ payload: { cloudConnect: true }, upgrade: vi.fn() }));
vi.mock("./useEntitlement", () => ({ useEntitlement: () => mockUseEntitlement() }));
const openUpgrade = vi.fn();
vi.mock("./UpgradeContext", () => ({ useUpgrade: () => ({ openUpgrade }) }));

import { ConnectClusterModal } from "./ConnectClusterModal";

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

test("renders all cloud providers and Import as enabled tiles when entitled", () => {
  mockUseEntitlement.mockReturnValue({ payload: { cloudConnect: true }, upgrade: vi.fn() });
  wrap(<ConnectClusterModal open onOpenChange={vi.fn()} />);
  expect(screen.getByRole("button", { name: /digitalocean/i })).toBeEnabled();
  expect(screen.getByRole("button", { name: /import a kubeconfig/i })).toBeEnabled();
  expect(screen.getByRole("button", { name: /amazon eks/i })).toBeEnabled();
  expect(screen.getByRole("button", { name: /google gke/i })).toBeEnabled();
  expect(screen.getByRole("button", { name: /azure aks/i })).toBeEnabled();
  expect(screen.queryByText(/coming soon/i)).toBeNull();
  expect(screen.queryByText("Pro")).toBeNull();
});

function Host() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button onClick={() => setOpen(false)}>close-from-flow</button>
      <button onClick={() => setOpen(true)}>reopen</button>
      <ConnectClusterModal open={open} onOpenChange={setOpen} />
    </>
  );
}

test("returns to the default title when a flow closes the modal and it reopens", async () => {
  mockUseEntitlement.mockReturnValue({ payload: { cloudConnect: true }, upgrade: vi.fn() });
  const u = userEvent.setup();
  wrap(<Host />);

  await u.click(screen.getByRole("button", { name: /import a kubeconfig/i }));
  expect(screen.getByRole("heading", { name: "Import a kubeconfig" })).toBeInTheDocument();

  await u.click(screen.getByRole("button", { name: "close-from-flow", hidden: true }));
  await u.click(screen.getByRole("button", { name: "reopen", hidden: true }));

  expect(screen.getByRole("heading", { name: "Connect a cluster" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Import a kubeconfig" })).toBeNull();
});

test("locks cloud providers on the free plan and opens upgrade on click", async () => {
  mockUseEntitlement.mockReturnValue({ payload: { cloudConnect: false }, upgrade: vi.fn() });
  openUpgrade.mockClear();
  const onOpenChange = vi.fn();
  wrap(<ConnectClusterModal open onOpenChange={onOpenChange} />);

  expect(screen.getAllByText("Pro").length).toBeGreaterThanOrEqual(4);

  await userEvent.click(screen.getByRole("button", { name: /google gke/i }));
  expect(openUpgrade).toHaveBeenCalled();
  expect(onOpenChange).toHaveBeenCalledWith(false);
});
