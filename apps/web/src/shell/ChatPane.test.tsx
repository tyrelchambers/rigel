// @vitest-environment jsdom
//
// ChatPane enablement gating. The chat composer + empty-state are gated on the
// ACTIVE agent's connection (from useAgents / GET /api/agents), NOT on the
// Claude-only chat-config token. These tests prove:
//   - active agent connected  → composer ENABLED, no empty-state (even w/ NO Claude token)
//   - active agent NOT connected → composer DISABLED, empty-state shown
//   - agents query still loading → treated as not-configured (disabled)
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentsResponse, AgentView } from "@/lib/api";

// The WS module is import-time side-effectful (opens a socket); stub the bits
// ChatPane touches so the render stays inert.
vi.mock("@/lib/ws", () => ({
  onChatEvent: () => () => {},
  sendChat: vi.fn(),
  interruptChat: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}));

import ChatPane from "./ChatPane";
import { useCluster } from "@/store/cluster";

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

/** Render ChatPane with the agents query pre-seeded (or left loading if omitted). */
function renderPane(agents?: AgentsResponse) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (agents) qc.setQueryData(["agents"], agents);
  // Pre-seed sibling queries so nothing tries to hit the network.
  qc.setQueryData(["suggestions"], []);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ChatPane />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function composer(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(/ask rigel|connect an agent/i) as HTMLTextAreaElement;
}

describe("ChatPane chat enablement (active-agent gating)", () => {
  beforeEach(() => {
    // jsdom doesn't implement scrollIntoView; ChatPane's autoscroll effect calls
    // it on mount. Stub it so the render doesn't throw.
    Element.prototype.scrollIntoView = vi.fn();
    // Connected cluster so the composer's `!connected` gate isn't the thing
    // disabling it; we want to isolate the agent-connection gate.
    useCluster.setState({ connected: true, resources: {} });
  });

  it("ENABLES the composer + hides the empty-state when the active agent is connected, even with NO Claude token", () => {
    // Codex is active + connected; Claude has no token (notConnected). This is
    // exactly the bug case: a Codex user with no Claude token must be able to chat.
    renderPane({ activeAgentId: "codex", agents: [claude, codex] });

    expect(composer()).not.toBeDisabled();
    expect(composer().placeholder).toMatch(/ask rigel/i);
    expect(screen.queryByText(/isn't set up yet/i)).not.toBeInTheDocument();
  });

  it("DISABLES the composer + shows the empty-state when the active agent is not connected", () => {
    renderPane({ activeAgentId: "claude", agents: [claude, codex] });

    expect(composer()).toBeDisabled();
    expect(composer().placeholder).toMatch(/connect an agent/i);
    expect(screen.getByText(/isn't set up yet/i)).toBeInTheDocument();
  });

  it("treats the still-loading agents query as not-configured (disabled)", () => {
    renderPane(); // no agents data seeded → query is loading

    expect(composer()).toBeDisabled();
    expect(screen.getByText(/isn't set up yet/i)).toBeInTheDocument();
  });
});
