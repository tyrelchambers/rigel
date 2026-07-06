// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_POLICY, serializePolicy } from "@rigel/k8s";
import { PermissionsTab } from "./PermissionsTab";
import { AssistantContext, type AssistantContextValue } from "../AssistantContext";

function ctx(overrides: Partial<AssistantContextValue> = {}): AssistantContextValue {
  return { ns: "default", working: false, run: vi.fn(), ...overrides } as unknown as AssistantContextValue;
}

function wrap(overrides: Partial<AssistantContextValue> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AssistantContext value={ctx(overrides)}>
        <PermissionsTab />
      </AssistantContext>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/assistant")) {
        const body = JSON.parse((init?.body as string) ?? "{}") as { action?: string };
        if (body.action === "getRbac") {
          return new Response(
            JSON.stringify({
              success: true,
              stdout: JSON.stringify({ policy: serializePolicy(DEFAULT_POLICY), appliedRules: null }),
              stderr: "",
            }),
          );
        }
        if (body.action === "setRbac") {
          return new Response(
            JSON.stringify({ success: true, stdout: JSON.stringify({ applied: ["kind-dev"], failures: [] }), stderr: "" }),
          );
        }
        return new Response(JSON.stringify({ success: true, stdout: "", stderr: "" }));
      }
      if (url.includes("/api/contexts")) {
        return new Response(
          JSON.stringify({ contexts: [{ name: "kind-dev", cluster: "kind-dev", server: "x", active: true }] }),
        );
      }
      return new Response(JSON.stringify({}));
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("PermissionsTab", () => {
  it("renders the header and starts on the Simple view", async () => {
    wrap();
    expect(screen.getByText("Permissions")).toBeInTheDocument();
    expect(await screen.findByText("Read everything")).toBeInTheDocument();
  });

  it("switching to Advanced swaps the view to the matrix", async () => {
    wrap();
    await screen.findByText("Read everything");
    await userEvent.click(screen.getByRole("tab", { name: "Advanced" }));
    expect(screen.getByRole("columnheader", { name: "get" })).toBeInTheDocument();
    expect(screen.queryByText("Read everything")).not.toBeInTheDocument();
  });

  it("footer hides the pending-changes count and disables actions with no staged edits", async () => {
    wrap();
    await screen.findByText("Read everything");
    expect(screen.getByRole("button", { name: /review changes/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^apply$/i })).toBeDisabled();
  });

  it("toggling a capability shows the pending count and enables the footer actions", async () => {
    wrap();
    await screen.findByText("Read everything");
    await userEvent.click(screen.getByRole("switch", { name: /delete workloads/i }));
    expect(await screen.findByText(/changes? pending/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /review changes/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^apply$/i })).toBeEnabled();
  });

  it("Review changes opens the ReviewDialog with the diff", async () => {
    wrap();
    await screen.findByText("Read everything");
    await userEvent.click(screen.getByRole("switch", { name: /delete workloads/i }));
    await userEvent.click(screen.getByRole("button", { name: /review changes/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Review changes")).toBeInTheDocument();
  });

  it("the target selector defaults to the active cluster and can switch to all installed clusters", async () => {
    wrap();
    await screen.findByText("Read everything");
    expect(await screen.findByRole("button", { name: /apply to/i })).toHaveTextContent(
      "Active cluster · kind-dev",
    );
    await userEvent.click(screen.getByRole("button", { name: /apply to/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /all installed clusters/i }));
    expect(screen.getByRole("button", { name: /apply to/i })).toHaveTextContent("all installed clusters");
  });
});
