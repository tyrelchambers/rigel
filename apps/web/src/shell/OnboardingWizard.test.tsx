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
function renderWizard(agents?: AgentsResponse, metricsAvailable?: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (agents) qc.setQueryData(["agents"], agents);
  if (metricsAvailable !== undefined) {
    qc.setQueryData(["metrics", "nodes"], { available: metricsAvailable, items: [] });
  }
  const onClose = vi.fn();
  const onLeave = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <OnboardingWizard onClose={onClose} onLeave={onLeave} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onClose, onLeave };
}

describe("OnboardingWizard AI-agent step", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("renders the real Agents picker on the AI step, not a Claude-token field", () => {
    renderWizard({ activeAgentId: "claude", agents: [claude, codex] });

    // The wizard opens on the AI step (first optional step). It shows the step
    // title + description in the chrome, and the agent cards below.
    expect(screen.getByText(/connect your ai agent/i)).toBeInTheDocument();
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText(/credentials never leave your machine/i)).toBeInTheDocument();

    // No leftover Claude-token field.
    expect(screen.queryByPlaceholderText(/token/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^save$/i })).not.toBeInTheDocument();
  });

  it("shows the Provider connected pill when the active agent is connected", () => {
    // Codex is active + connected → the stepper shows the status pill.
    renderWizard({ activeAgentId: "codex", agents: [claude, codex] });
    expect(screen.getByText(/provider connected/i)).toBeInTheDocument();
  });

  it("does NOT show the Provider connected pill when the active agent is not connected", () => {
    renderWizard({ activeAgentId: "claude", agents: [claude, codex] });
    expect(screen.queryByText(/provider connected/i)).not.toBeInTheDocument();
  });

  it("keeps the AI step skippable (Skip advances past it without connecting)", () => {
    renderWizard({ activeAgentId: "claude", agents: [claude, codex] });

    // AI step (label in the stepper) is the active step.
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
    expect(screen.getByText("· AI agent")).toBeInTheDocument();

    // Skip moves on without requiring a connected agent.
    fireEvent.click(screen.getByRole("button", { name: /^skip$/i }));
    expect(screen.getByText("· Assistant")).toBeInTheDocument();
  });
});

describe("OnboardingWizard streamlined steps", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("has three steps ending in a Next steps panel", () => {
    renderWizard({ activeAgentId: "claude", agents: [claude, codex] }, false);
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
    expect(screen.getByText("· AI agent")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^next →$/i }));
    expect(screen.getByText("· Assistant")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^next →$/i }));
    expect(screen.getByText("Step 3 of 3")).toBeInTheDocument();
    expect(screen.getByText("· Next steps")).toBeInTheDocument();
  });

  it("nudges to install metrics-server on the Assistant step when it's unavailable", () => {
    renderWizard({ activeAgentId: "claude", agents: [claude, codex] }, false);
    fireEvent.click(screen.getByRole("button", { name: /^next →$/i })); // → Assistant
    expect(screen.getByText(/metrics-server/i)).toBeInTheDocument();
  });

  it("hides the metrics nudge when metrics-server is already available", () => {
    renderWizard({ activeAgentId: "claude", agents: [claude, codex] }, true);
    fireEvent.click(screen.getByRole("button", { name: /^next →$/i })); // → Assistant
    expect(screen.queryByText(/metrics-server/i)).not.toBeInTheDocument();
  });
});

describe("OnboardingWizard leaving to a real feature", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("the Compose next-step leaves without marking onboarding complete", () => {
    const { onClose, onLeave } = renderWizard({ activeAgentId: "claude", agents: [claude, codex] }, false);
    fireEvent.click(screen.getByRole("button", { name: /^next →$/i })); // → Assistant
    fireEvent.click(screen.getByRole("button", { name: /^next →$/i })); // → Next steps
    fireEvent.click(screen.getByRole("button", { name: /^import$/i }));
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("the notifications next-step leaves without marking onboarding complete", () => {
    const { onClose, onLeave } = renderWizard({ activeAgentId: "claude", agents: [claude, codex] }, false);
    fireEvent.click(screen.getByRole("button", { name: /^next →$/i })); // → Assistant
    fireEvent.click(screen.getByRole("button", { name: /^next →$/i })); // → Next steps
    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});
