// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_POLICY, clusterRoleRules, serializePolicy, setCapability } from "@rigel/k8s";
import { PermissionsTab } from "./PermissionsTab";
import { AssistantContext, type AssistantContextValue } from "../AssistantContext";

function ctx(overrides: Partial<AssistantContextValue> = {}): AssistantContextValue {
  return { ns: "default", working: false, run: vi.fn(), ...overrides } as unknown as AssistantContextValue;
}

function wrap(overrides: Partial<AssistantContextValue> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AssistantContext value={ctx(overrides)}>
        <PermissionsTab />
      </AssistantContext>
    </QueryClientProvider>,
  );
}

let failSetRbac = false;
let appliedRules: unknown = null;
let installedContexts: { name: string; active: boolean }[] = [{ name: "kind-dev", active: true }];

beforeEach(() => {
  failSetRbac = false;
  appliedRules = null;
  installedContexts = [{ name: "kind-dev", active: true }];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/assistant")) {
        const body = JSON.parse((init?.body as string) ?? "{}") as { action?: string };
        if (body.action === "getRbac") {
          return new Response(
            JSON.stringify({
              success: true,
              stdout: JSON.stringify({ policy: serializePolicy(DEFAULT_POLICY), appliedRules }),
              stderr: "",
            }),
          );
        }
        if (body.action === "installedContexts") {
          return new Response(
            JSON.stringify({
              success: true,
              stdout: JSON.stringify({ contexts: installedContexts }),
              stderr: "",
            }),
          );
        }
        if (body.action === "setRbac") {
          if (failSetRbac) {
            return new Response(
              JSON.stringify({ error: "Failed to apply RBAC to kind-dev: Forbidden" }),
              { status: 500 },
            );
          }
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

function setRbacBodies(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .filter((call: unknown[]) => String(call[0]).includes("/api/assistant"))
    .map((call: unknown[]) => JSON.parse(((call[1] as RequestInit | undefined)?.body as string) ?? "{}"))
    .filter((body: { action?: string }) => body.action === "setRbac");
}

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

  it("footer hides the pending-changes count and disables Apply with no staged edits", async () => {
    wrap();
    await screen.findByText("Read everything");
    expect(screen.getByRole("button", { name: /^apply$/i })).toBeDisabled();
  });

  it("toggling a capability shows the pending count and enables Apply", async () => {
    wrap();
    await screen.findByText("Read everything");
    await userEvent.click(screen.getByRole("switch", { name: /delete workloads/i }));
    expect(await screen.findByText(/changes? pending/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^apply$/i })).toBeEnabled();
  });

  it("Apply opens the ReviewDialog showing the diff and the active cluster", async () => {
    wrap();
    await screen.findByText("Read everything");
    await userEvent.click(screen.getByRole("switch", { name: /delete workloads/i }));
    await userEvent.click(screen.getByRole("button", { name: /^apply$/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Review changes")).toBeInTheDocument();
    expect(within(dialog).getByText(/Active cluster · kind-dev/)).toBeInTheDocument();
  });

  it("a failed apply keeps the ReviewDialog open and shows the error instead of reporting success", async () => {
    failSetRbac = true;
    wrap();
    await screen.findByText("Read everything");
    await userEvent.click(screen.getByRole("switch", { name: /delete workloads/i }));
    await userEvent.click(screen.getByRole("button", { name: /^apply$/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /^apply$/i }));
    expect(await within(dialog).findByText(/Failed to apply RBAC to kind-dev: Forbidden/)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("a failed Re-apply from the drift banner shows the error inline", async () => {
    failSetRbac = true;
    appliedRules = clusterRoleRules(setCapability(DEFAULT_POLICY, "deleteWorkloads", true));
    wrap();
    await screen.findByText(/live permissions differ from your saved policy/i);
    await userEvent.click(screen.getByRole("button", { name: /re-apply/i }));
    expect(await screen.findByText(/Failed to apply RBAC to kind-dev: Forbidden/)).toBeInTheDocument();
  });

  it("Apply confirms then applies to the active context only", async () => {
    const { unmount } = wrap();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await screen.findByText("Read everything");
    await userEvent.click(screen.getByRole("switch", { name: /delete workloads/i }));
    await userEvent.click(screen.getByRole("button", { name: /^apply$/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /^apply$/i }));
    await vi.waitFor(() => expect(setRbacBodies(fetchMock).length).toBeGreaterThan(0));
    expect(setRbacBodies(fetchMock)[0]).toEqual(expect.objectContaining({ contexts: ["kind-dev"] }));
    unmount();
  });

  it("Save to all clusters confirms then applies to every installed context", async () => {
    installedContexts = [
      { name: "kind-dev", active: true },
      { name: "prod-cluster", active: false },
    ];
    const { unmount } = wrap();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await screen.findByText("Read everything");
    await userEvent.click(screen.getByRole("switch", { name: /delete workloads/i }));
    await userEvent.click(screen.getByRole("button", { name: /more apply options/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /save to all clusters/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/All installed clusters \(2\)/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: /^apply$/i }));
    await vi.waitFor(() => expect(setRbacBodies(fetchMock).length).toBeGreaterThan(0));
    expect(setRbacBodies(fetchMock)[0]).toEqual(
      expect.objectContaining({ contexts: ["kind-dev", "prod-cluster"] }),
    );
    unmount();
  });

  it("Copy to clusters confirms then applies to the picked subset", async () => {
    installedContexts = [
      { name: "kind-dev", active: true },
      { name: "prod-cluster", active: false },
    ];
    const { unmount } = wrap();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await screen.findByText("Read everything");
    await userEvent.click(screen.getByRole("switch", { name: /delete workloads/i }));
    await userEvent.click(screen.getByRole("button", { name: /more apply options/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /copy to clusters/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "prod-cluster" }));
    await userEvent.click(within(dialog).getByRole("button", { name: /copy/i }));
    await vi.waitFor(() => expect(setRbacBodies(fetchMock).length).toBeGreaterThan(0));
    expect(setRbacBodies(fetchMock)[0]).toEqual(expect.objectContaining({ contexts: ["prod-cluster"] }));
    unmount();
  });

  it("greys out the fan-out caret (aria-disabled, no menu) when no other cluster has the assistant", async () => {
    // Default fixture: only the active kind-dev cluster is installed.
    wrap();
    await screen.findByText("Read everything");
    const caret = screen.getByRole("button", { name: /more apply options/i });
    expect(caret).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(caret);
    expect(screen.queryByRole("menuitem", { name: /save to all clusters/i })).not.toBeInTheDocument();
  });

  it("shows a drift banner with Re-apply when the live ClusterRole diverges from the saved policy", async () => {
    appliedRules = clusterRoleRules(setCapability(DEFAULT_POLICY, "deleteWorkloads", true));
    const { unmount } = wrap();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(
      await screen.findByText(/live permissions differ from your saved policy/i),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /re-apply/i }));
    await vi.waitFor(() => expect(setRbacBodies(fetchMock).length).toBeGreaterThan(0));
    expect(setRbacBodies(fetchMock)[0]).toEqual(expect.objectContaining({ contexts: ["kind-dev"] }));
    unmount();
  });
});
