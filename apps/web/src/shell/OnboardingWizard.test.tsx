// @vitest-environment jsdom
//
// The onboarding AI step now connects an agent through the REAL Agents flow
// (AgentsTab: grid → per-agent auth), NOT a Claude-token field. These tests prove:
//   - the AI step renders the agents picker (no Claude-token input)
//   - the step is present in the wizard and is skippable (Skip/Next advance it)
//   - the step shows "Done" once the ACTIVE agent is connected (derived from
//     useAgents, mirroring ChatPane), and does not when it isn't
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentsResponse, AgentView } from "@/lib/api";

import { OnboardingWizard } from "./OnboardingWizard";

const claude: AgentView = {
  id: "claude", label: "Claude Code", vendor: "Anthropic", status: "available",
  connection: "notConnected", authMethods: ["subscription", "apiKey"], authMethod: "subscription",
  installUrl: "https://x", installLabel: "Install Claude Code",
};
const codex: AgentView = {
  id: "codex", label: "Codex", vendor: "OpenAI", status: "available",
  connection: "connected", authMethods: ["subscription", "apiKey"], authMethod: "subscription",
  installUrl: "https://x", installLabel: "Install Codex",
};

/** Render the wizard (optional onboarding, no About-you gate) with the agents
 *  query pre-seeded so the AI step's pick-and-connect grid has data. */
function renderWizard(agents?: AgentsResponse) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (agents) qc.setQueryData(["agents"], agents);
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <OnboardingWizard onClose={onClose} requireAboutYou={false} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onClose };
}

describe("OnboardingWizard AI-agent step", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("renders the real Agents picker on the AI step, not a Claude-token field", () => {
    renderWizard({ activeAgentId: "claude", agents: [claude, codex] });

    // The wizard opens on the AI step (first optional step). It shows the
    // AgentsTab heading + agent cards, and onboarding framing pointing to Settings.
    expect(screen.getByText(/connect your ai agent/i)).toBeInTheDocument();
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText(/settings, then agents/i)).toBeInTheDocument();

    // No leftover Claude-token field.
    expect(screen.queryByPlaceholderText(/token/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^save$/i })).not.toBeInTheDocument();
  });

  it("shows Done on the AI step when the active agent is connected", () => {
    // Codex is active + connected → the step reports Done.
    renderWizard({ activeAgentId: "codex", agents: [claude, codex] });
    expect(screen.getByText(/^done$/i)).toBeInTheDocument();
  });

  it("does NOT show Done when the active agent is not connected", () => {
    renderWizard({ activeAgentId: "claude", agents: [claude, codex] });
    expect(screen.queryByText(/^done$/i)).not.toBeInTheDocument();
  });

  it("keeps the AI step skippable (Skip advances past it without connecting)", () => {
    renderWizard({ activeAgentId: "claude", agents: [claude, codex] });

    // AI step (label in the stepper) is the active step.
    expect(screen.getByText(/Step 1 of 4 · AI agent/i)).toBeInTheDocument();

    // Skip moves on without requiring a connected agent.
    fireEvent.click(screen.getByRole("button", { name: /^skip$/i }));
    expect(screen.getByText(/Step 2 of 4 · Assistant/i)).toBeInTheDocument();
  });
});
