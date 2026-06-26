// @vitest-environment jsdom
import { test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectClusterModal } from "./ConnectClusterModal";

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

test("renders all cloud providers and Import as enabled tiles", () => {
  wrap(<ConnectClusterModal open onOpenChange={vi.fn()} />);
  expect(screen.getByRole("button", { name: /digitalocean/i })).toBeEnabled();
  expect(screen.getByRole("button", { name: /import a kubeconfig/i })).toBeEnabled();
  expect(screen.getByRole("button", { name: /amazon eks/i })).toBeEnabled();
  expect(screen.getByRole("button", { name: /google gke/i })).toBeEnabled();
  expect(screen.getByRole("button", { name: /azure aks/i })).toBeEnabled();
  expect(screen.queryByText(/coming soon/i)).toBeNull();
});
