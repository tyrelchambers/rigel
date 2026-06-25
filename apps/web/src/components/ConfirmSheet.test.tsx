// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Override only fetchPreviewCommand so the Execute button enables; keep the rest
// of the api module real (useAction, etc.).
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, fetchPreviewCommand: vi.fn(async () => ["kubectl", "drain", "k8s-truenas"]) };
});

// Spy on the background runner.
const runActionInBackground = vi.fn();
vi.mock("@/lib/actionRunner", () => ({
  runActionInBackground: (...a: unknown[]) => runActionInBackground(...a),
}));

import { ConfirmSheet } from "./ConfirmSheet";
import type { ActionBlock } from "@/lib/api";

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  runActionInBackground.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ purge: true, name: null, namespace: "default" }) })));
});

describe("ConfirmSheet — non-blocking execute", () => {
  it("closes the modal immediately and runs the action in the background", async () => {
    const onClose = vi.fn();
    const drain: ActionBlock = { kind: "drain", node: "k8s-truenas", label: "Drain node k8s-truenas" };

    wrap(<ConfirmSheet action={drain} open={true} onClose={onClose} />);

    // Wait for the preview command to load so Execute enables.
    const execute = await screen.findByRole("button", { name: /execute/i });
    await waitFor(() => expect(execute).not.toBeDisabled());

    await userEvent.click(execute);

    // The modal closes right away — it does NOT stay open in a "Running…" state.
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(runActionInBackground).toHaveBeenCalledTimes(1);
    expect(runActionInBackground.mock.calls[0]?.[0]).toMatchObject({
      action: drain,
      label: "Drain node k8s-truenas",
      commandString: "kubectl drain k8s-truenas",
    });
  });

  it("keeps purge in-modal (does not background-run it)", async () => {
    const onClose = vi.fn();
    const onPurge = vi.fn();
    const purge: ActionBlock = { kind: "purge", name: "affine", namespace: "default", label: "Remove affine" };

    wrap(<ConfirmSheet action={purge} open={true} onClose={onClose} onPurge={onPurge} />);

    const cont = await screen.findByRole("button", { name: /continue to removal/i });
    await userEvent.click(cont);

    expect(runActionInBackground).not.toHaveBeenCalled();
  });
});
