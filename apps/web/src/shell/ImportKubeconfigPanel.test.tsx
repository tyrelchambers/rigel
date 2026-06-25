// @vitest-environment jsdom
import { test, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ImportKubeconfigPanel } from "./ImportKubeconfigPanel";

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

test("Import is disabled until text is entered, then submits and reports added contexts", async () => {
  const onImport = vi.fn().mockResolvedValue({ ok: true, added: ["do-nyc1-new"], backupPath: null });
  const onDone = vi.fn();
  wrap(<ImportKubeconfigPanel onImport={onImport} onDone={onDone} />);

  const btn = screen.getByRole("button", { name: /import/i });
  expect(btn).toBeDisabled();

  fireEvent.change(screen.getByLabelText(/kubeconfig/i), { target: { value: "apiVersion: v1" } });
  expect(btn).toBeEnabled();

  fireEvent.click(btn);
  await waitFor(() => expect(onImport).toHaveBeenCalledWith("apiVersion: v1"));
  await waitFor(() => expect(onDone).toHaveBeenCalled());
});

test("shows the error when import throws", async () => {
  const onImport = vi.fn().mockRejectedValue(new Error("invalid kubeconfig"));
  wrap(<ImportKubeconfigPanel onImport={onImport} onDone={vi.fn()} />);
  fireEvent.change(screen.getByLabelText(/kubeconfig/i), { target: { value: "garbage" } });
  fireEvent.click(screen.getByRole("button", { name: /import/i }));
  await waitFor(() => expect(screen.getByText(/invalid kubeconfig/i)).toBeInTheDocument());
});
