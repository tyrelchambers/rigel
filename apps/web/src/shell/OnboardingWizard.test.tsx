// @vitest-environment jsdom
//
// The wizard is the single first-run surface: Cluster → AI agent → Email. The AI
// step connects an agent through the REAL Agents flow (AgentsTab: grid →
// per-agent auth), NOT a Claude-token field, and carries the two optional
// in-cluster installs. Leaving early must not mark setup complete.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentsResponse, AgentView } from "@/lib/api";
import type { UseAccountResult } from "./useAccount";

import { OnboardingWizard } from "./OnboardingWizard";

const claude: AgentView = {
  id: "claude", label: "Claude Code", vendor: "Anthropic", status: "available",
  connection: "notSignedIn", authMethods: ["subscription", "apiKey"], authMethod: "subscription",
  installUrl: "https://x", installLabel: "Install Claude Code",
};
const codex: AgentView = {
  id: "codex", label: "Codex", vendor: "OpenAI", status: "available",
  connection: "connected", authMethods: ["subscription", "apiKey"], authMethod: "subscription",
  installUrl: "https://x", installLabel: "Install Codex",
};

function fakeAccount(over: Partial<UseAccountResult> = {}): UseAccountResult {
  return {
    status: "signed-out",
    account: null,
    me: null,
    orgs: [],
    entitlement: null,
    pendingSignIn: null,
    startSignIn: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    signOut: vi.fn(),
    refresh: vi.fn(),
    upgrade: vi.fn(),
    manageBilling: vi.fn(),
    refreshBilling: vi.fn(),
    ...over,
  } as UseAccountResult;
}

function renderWizard(agents?: AgentsResponse, metricsAvailable?: boolean, account = fakeAccount()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (agents) qc.setQueryData(["agents"], agents);
  if (metricsAvailable !== undefined) {
    qc.setQueryData([null, "metrics", "nodes"], { available: metricsAvailable, items: [] });
  }
  qc.setQueryData(["contexts"], []);
  const onClose = vi.fn();
  const onLeave = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <OnboardingWizard account={account} onClose={onClose} onLeave={onLeave} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onClose, onLeave, account };
}

describe("OnboardingWizard AI-agent step", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("renders the real Agents picker on the AI step, not a Claude-token field", () => {
    renderWizard({ activeAgentId: "claude", agents: [claude, codex] });
    fireEvent.click(screen.getByRole("button", { name: /^skip$/i }));

    expect(screen.getByText(/connect your ai agent/i)).toBeInTheDocument();
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText(/credentials never leave your machine/i)).toBeInTheDocument();

    // No leftover Claude-token field.
    expect(screen.queryByPlaceholderText(/token/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^save$/i })).not.toBeInTheDocument();
  });

  it("shows the Provider connected pill when the active agent is connected", () => {
    // Codex is active + connected → the step head shows the status pill.
    renderWizard({ activeAgentId: "codex", agents: [claude, codex] });
    fireEvent.click(screen.getByRole("button", { name: /^skip$/i }));
    expect(screen.getByText(/provider connected/i)).toBeInTheDocument();
  });

  it("does NOT show the pill when a non-active agent is the connected one", () => {
    // Claude is active but notSignedIn; codex is connected but NOT active. The
    // pill tracks the ACTIVE agent, so "any agent connected" must not light it.
    renderWizard({ activeAgentId: "claude", agents: [claude, codex] });
    fireEvent.click(screen.getByRole("button", { name: /^skip$/i }));
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.queryByText(/provider connected/i)).not.toBeInTheDocument();
  });

  it("keeps the AI step skippable (Skip advances past it without connecting)", () => {
    renderWizard({ activeAgentId: "claude", agents: [claude, codex] });
    fireEvent.click(screen.getByRole("button", { name: /^skip$/i }));

    expect(document.querySelector('[aria-current="step"]')).toHaveTextContent("AI agent");

    fireEvent.click(screen.getByRole("button", { name: /^skip$/i }));
    expect(document.querySelector('[aria-current="step"]')).toHaveTextContent("Email");
  });
});

describe("OnboardingWizard steps", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("has exactly three steps: Cluster, AI agent, Email", () => {
    renderWizard();
    expect(screen.getByText("Cluster")).toBeInTheDocument();
    expect(screen.getByText("AI agent")).toBeInTheDocument();
    expect(screen.getByText("Email")).toBeInTheDocument();
    expect(screen.queryByText("Assistant")).not.toBeInTheDocument();
    expect(screen.queryByText("Next steps")).not.toBeInTheDocument();
  });

  it("opens on the cluster step", () => {
    renderWizard();
    expect(screen.getByText("Create a local cluster")).toBeInTheDocument();
  });

  it("walks Cluster to AI agent to Email and finishes", () => {
    const { onClose } = renderWizard();
    fireEvent.click(screen.getByRole("button", { name: /^skip$/i }));
    expect(screen.getByText(/connect your ai agent/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^skip$/i }));
    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^skip$/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("drops the Compose and notifications link farm and the upsell", () => {
    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: /^skip$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^skip$/i }));
    expect(screen.queryByText(/compose stack/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/set up notifications/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/free plan/i)).not.toBeInTheDocument();
  });

  it("offers the Assistant and metrics-server installs as an optional row on the AI step", () => {
    renderWizard(undefined, false);
    fireEvent.click(screen.getByRole("button", { name: /^skip$/i }));
    expect(screen.getByText("Assistant agent")).toBeInTheDocument();
    expect(screen.getByText("metrics-server")).toBeInTheDocument();
  });

  it("hides metrics-server when the cluster already has it", () => {
    renderWizard(undefined, true);
    fireEvent.click(screen.getByRole("button", { name: /^skip$/i }));
    expect(screen.getByText("Assistant agent")).toBeInTheDocument();
    expect(screen.queryByText("metrics-server")).not.toBeInTheDocument();
  });

  it("marks onboarding complete only from the last step", () => {
    const { onClose, onLeave } = renderWizard();
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).not.toHaveBeenCalled();
    expect(onLeave).toHaveBeenCalledOnce();
  });
});
