// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Keep the api module real except the kubectl preview (so the delete ConfirmSheet
// opens without a live cluster).
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchPreviewCommand: vi.fn(async () => ["kubectl", "delete", "configmap", "app-config", "-n", "default"]),
  };
});

import { ConfigMapDetail } from "./ConfigMapDetail";
import type { ConfigMap } from "./types";

const CERT = "-----BEGIN CERTIFICATE-----\nAAAA\nBBBB\n-----END CERTIFICATE-----";

const cm: ConfigMap = {
  metadata: {
    name: "app-config",
    namespace: "default",
    uid: "c1",
    creationTimestamp: new Date(Date.now() - 165 * 86400_000).toISOString(),
  },
  data: { "ca.crt": CERT, "config.json": '{"a":1}' },
  binaryData: { "keystore.jks": "AAECAwQ=" },
};

function wrap(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const writeText = vi.fn(() => Promise.resolve());

beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ code: 0, yaml: "kind: ConfigMap\n" }) })));
});

describe("ConfigMapDetail", () => {
  it("renders the meta strip and a typed code-preview card per key", () => {
    wrap(<ConfigMapDetail configMap={cm} onEdit={() => {}} />);

    // Meta strip
    expect(screen.getByText("KEYS · 3")).toBeTruthy();
    expect(screen.getByText("165 days")).toBeTruthy();
    expect(screen.getByText("default")).toBeTruthy();

    // Key names
    expect(screen.getByText("ca.crt")).toBeTruthy();
    expect(screen.getByText("config.json")).toBeTruthy();
    expect(screen.getByText("keystore.jks")).toBeTruthy();

    // Detected kind badges
    expect(screen.getByText("CERTIFICATE")).toBeTruthy();
    expect(screen.getByText("JSON")).toBeTruthy();
    expect(screen.getByText("BINARY")).toBeTruthy();

    // Cert renders numbered lines + a line count; binary shows a note, no lines.
    expect(screen.getByText("-----BEGIN CERTIFICATE-----")).toBeTruthy();
    expect(screen.getByText("4 lines")).toBeTruthy();
    expect(screen.getByText(/^<binary data/)).toBeTruthy();
  });

  it("copies a single key's value from its per-key Copy button", async () => {
    wrap(<ConfigMapDetail configMap={cm} onEdit={() => {}} />);
    // Per-key Copy buttons come first in the DOM (before the Manage-bar Copy);
    // the first is ca.crt's.
    const copyButtons = screen.getAllByRole("button", { name: "Copy" });
    await userEvent.click(copyButtons[0]);
    expect(writeText).toHaveBeenCalledWith(CERT);
  });

  it("opens the guarded confirm dialog when Delete is clicked", async () => {
    wrap(<ConfigMapDetail configMap={cm} onEdit={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    // ConfirmSheet's title is the action label.
    expect(await screen.findByText("Delete app-config")).toBeTruthy();
  });

  it("shows the Edit action", async () => {
    const onEdit = vi.fn();
    wrap(<ConfigMapDetail configMap={cm} onEdit={onEdit} />);
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(onEdit).toHaveBeenCalledOnce();
  });
});
