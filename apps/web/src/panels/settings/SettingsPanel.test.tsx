// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  useAgents: () => ({ data: { activeAgentId: "claude", agents: [] } }),
  useAssistantAction: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAgentModels: () => ({ data: null }),
}));

vi.mock("../assistant/useAssistant", () => ({
  useAssistant: () => ({
    roles: {
      worker: { provider: "claude", model: "claude-sonnet-4-6", effort: "high" },
      supervisor: { provider: "claude", model: "claude-opus-4-8", effort: "high" },
    },
    limits: {},
    creds: {},
    credentialSources: {},
    credentialConflicts: [],
    credentialNeedsReconcile: false,
    installedNamespace: null,
  }),
}));

vi.mock("@/store/cluster", () => ({
  useCluster: () => ({ resources: {} }),
}));

vi.mock("@/lib/ws", () => ({
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}));

function wrap(ui: React.ReactNode, initialEntries: string[] = ["/settings"]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("SettingsPanel", () => {
  it("shows the tabs and switches to App defaults", async () => {
    const { default: SettingsPanel } = await import("./SettingsPanel");
    wrap(<SettingsPanel />);
    expect(screen.getByRole("tab", { name: /overview/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /ai agents/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /channels/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /app defaults/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /failover/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /keyboard/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /app defaults/i }));
    expect(screen.getByText(/self-hosted app defaults/i)).toBeInTheDocument();
  });

  it("grays the assistant config with a banner when no agent connected", async () => {
    const { default: SettingsPanel } = await import("./SettingsPanel");
    wrap(<SettingsPanel />);
    fireEvent.click(screen.getByRole("tab", { name: /ai agents/i }));
    expect(screen.getByText(/connect an agent to configure the assistant/i)).toBeInTheDocument();
  });

  it("deep-links to the AI agents tab via ?tab=agents", async () => {
    const { default: SettingsPanel } = await import("./SettingsPanel");
    wrap(<SettingsPanel />, ["/settings?tab=agents"]);
    expect(screen.getByText(/connect an agent to configure the assistant/i)).toBeInTheDocument();
  });

  it("reopens onboarding via the rigel:open-setup event when Setup guide is clicked", async () => {
    const { default: SettingsPanel } = await import("./SettingsPanel");
    const spy = vi.fn();
    window.addEventListener("rigel:open-setup", spy);
    wrap(<SettingsPanel />);
    fireEvent.click(screen.getByRole("button", { name: /setup guide/i }));
    expect(spy).toHaveBeenCalledTimes(1);
    window.removeEventListener("rigel:open-setup", spy);
  });
});
