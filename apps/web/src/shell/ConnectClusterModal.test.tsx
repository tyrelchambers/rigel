// @vitest-environment jsdom
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
