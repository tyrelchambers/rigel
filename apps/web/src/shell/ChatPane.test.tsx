// @vitest-environment jsdom
//
// ChatPane enablement gating. The chat composer + empty-state are gated on the
// ACTIVE agent's connection (from useAgents / GET /api/agents), NOT on the
// Claude-only chat-config token. These tests prove:
//   - active agent connected  → composer ENABLED, no empty-state (even w/ NO Claude token)
//   - active agent NOT connected → composer DISABLED, empty-state shown
//   - agents query still loading → treated as not-configured (disabled)
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentsResponse, AgentView, AgentModels } from "@/lib/api";
import { handoffToChat } from "@/lib/chatHandoff";

// The WS module is import-time side-effectful (opens a socket); stub the bits
// ChatPane touches so the render stays inert. sendChat is captured so the
// model-picker tests can assert the config that gets sent.
const sendChat = vi.fn();
vi.mock("@/lib/ws", () => ({
  onChatEvent: () => () => {},
  sendChat: (...args: unknown[]) => sendChat(...args),
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
const claudeConnected: AgentView = { ...claude, connection: "connected" };
const codex: AgentView = {
  id: "codex", label: "Codex", vendor: "OpenAI", status: "available",
  connection: "connected", authMethods: ["subscription", "apiKey"], authMethod: "subscription",
  installUrl: "https://x", installLabel: "Install Codex",
};
const opencode: AgentView = {
  id: "opencode", label: "OpenCode", vendor: "OpenCode", status: "available",
  connection: "connected", authMethods: ["subscription", "apiKey"], authMethod: "subscription",
  installUrl: "https://x", installLabel: "Install OpenCode",
};

const CLAUDE_MODELS: AgentModels = { models: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001", "claude-fable-5"], efforts: ["low", "medium", "high", "xhigh", "max"] };
const OPENCODE_MODELS: AgentModels = { models: ["anthropic/claude-sonnet-4-6", "openai/gpt-5", "google/gemini-2.5-pro"], efforts: [] };

/**
 * Render ChatPane with the agents query pre-seeded (or left loading if omitted),
 * plus optional per-agent model lists keyed for useAgentModels.
 */
function renderPane(agents?: AgentsResponse, models?: Partial<Record<string, AgentModels>>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (agents) qc.setQueryData(["agents"], agents);
  // Pre-seed sibling queries so nothing tries to hit the network.
  qc.setQueryData(["suggestions"], []);
  for (const [id, m] of Object.entries(models ?? {})) {
    qc.setQueryData(["agentModels", id], m);
  }
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
    localStorage.clear();
    sendChat.mockClear();
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

/** Open the model picker by clicking the chip, returning its listbox. */
function openModelPicker(): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: /choose model/i }));
  return screen.getByRole("listbox", { name: /model/i });
}

describe("ChatPane agent-aware model picker", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    useCluster.setState({ connected: true, resources: {} });
    localStorage.clear();
    sendChat.mockClear();
  });

  it("renders the ACTIVE Claude agent's models + a reasoning-effort segment", () => {
    renderPane({ activeAgentId: "claude", agents: [claudeConnected, codex] }, { claude: CLAUDE_MODELS });

    // Chip pretty-prints the default Claude model.
    expect(screen.getByRole("button", { name: /choose model/i })).toHaveTextContent("Opus 4.8");

    const listbox = openModelPicker();
    // Pretty Claude names as options.
    expect(within(listbox).getByRole("option", { name: /Opus 4\.8/ })).toBeInTheDocument();
    expect(within(listbox).getByRole("option", { name: /Sonnet 4\.6/ })).toBeInTheDocument();
    // Effort segment is present for Claude.
    expect(within(listbox).getByText(/reasoning effort/i)).toBeInTheDocument();
    expect(within(listbox).getByRole("button", { name: "High" })).toBeInTheDocument();
  });

  it("renders OpenCode provider/model rows, a search box, and NO effort section", () => {
    renderPane({ activeAgentId: "opencode", agents: [opencode] }, { opencode: OPENCODE_MODELS });

    // Chip shows the raw id (first model) for opencode.
    expect(screen.getByRole("button", { name: /choose model/i })).toHaveTextContent(
      "anthropic/claude-sonnet-4-6",
    );

    const listbox = openModelPicker();
    expect(within(listbox).getByRole("option", { name: "openai/gpt-5" })).toBeInTheDocument();
    // No reasoning-effort section when efforts is empty.
    expect(within(listbox).queryByText(/reasoning effort/i)).not.toBeInTheDocument();
    // Search box is always shown for opencode.
    const search = within(listbox).getByLabelText(/search models/i);
    expect(search).toBeInTheDocument();
    // Filtering narrows the rows.
    fireEvent.change(search, { target: { value: "gemini" } });
    expect(within(listbox).getByRole("option", { name: "google/gemini-2.5-pro" })).toBeInTheDocument();
    expect(within(listbox).queryByRole("option", { name: "openai/gpt-5" })).not.toBeInTheDocument();
  });

  it("selecting a model updates the chip and the config that gets sent", () => {
    renderPane({ activeAgentId: "claude", agents: [claudeConnected, codex] }, { claude: CLAUDE_MODELS });

    fireEvent.click(within(openModelPicker()).getByRole("option", { name: /Sonnet 4\.6/ }));
    expect(screen.getByRole("button", { name: /choose model/i })).toHaveTextContent("Sonnet 4.6");

    // Send a message and assert the chosen model/effort flow through to sendChat.
    fireEvent.change(composer(), { target: { value: "hi" } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    expect(sendChat).toHaveBeenCalledWith("hi", expect.objectContaining({ model: "claude-sonnet-4-6", effort: "high" }));
  });

  it("keeps a per-agent selection (the stored choice is restored on next render)", () => {
    // First mount: active Codex, pick gpt-5.
    const codexModels: AgentModels = { models: ["gpt-5-codex", "gpt-5.4", "gpt-5"], efforts: [] };
    const { unmount } = renderPane({ activeAgentId: "codex", agents: [codex] }, { codex: codexModels });
    fireEvent.click(within(openModelPicker()).getByRole("option", { name: "gpt-5" }));
    expect(screen.getByRole("button", { name: /choose model/i })).toHaveTextContent("gpt-5");
    unmount();

    // Remount with Codex still active: the persisted choice is restored.
    renderPane({ activeAgentId: "codex", agents: [codex] }, { codex: codexModels });
    expect(screen.getByRole("button", { name: /choose model/i })).toHaveTextContent("gpt-5");
  });

  it("switching the active agent shows that agent's own selection", () => {
    // Codex selection persisted from a prior session.
    localStorage.setItem(
      "rigel.modelConfig.v2",
      JSON.stringify({ claude: { model: "claude-haiku-4-5-20251001", effort: "low" }, codex: { model: "gpt-5.4" } }),
    );

    // Active = Claude → shows the Claude selection.
    const claudeRender = renderPane(
      { activeAgentId: "claude", agents: [claudeConnected, codex] },
      { claude: CLAUDE_MODELS },
    );
    expect(screen.getByRole("button", { name: /choose model/i })).toHaveTextContent("Haiku 4.5");
    claudeRender.unmount();

    // Active = Codex → shows the Codex selection (raw id).
    const codexModels: AgentModels = { models: ["gpt-5-codex", "gpt-5.4", "gpt-5"], efforts: [] };
    renderPane({ activeAgentId: "codex", agents: [codex] }, { codex: codexModels });
    expect(screen.getByRole("button", { name: /choose model/i })).toHaveTextContent("gpt-5.4");
  });
});

describe("new-thread handoff", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    useCluster.setState({ connected: true, resources: {} });
    localStorage.clear();
    sendChat.mockClear();
  });

  it("resets the conversation and sends without a sessionId", async () => {
    sendChat.mockClear();
    renderPane({ activeAgentId: "claude", agents: [claudeConnected, codex] }, { claude: CLAUDE_MODELS });

    // Seed the current thread with an appended message.
    handoffToChat("old message");
    expect(await screen.findByText("old message")).toBeInTheDocument();

    // New-thread handoff clears the old message and seeds the new one.
    handoffToChat("investigate this warning", { newThread: true });
    expect(await screen.findByText("investigate this warning")).toBeInTheDocument();
    expect(screen.queryByText("old message")).not.toBeInTheDocument();

    // The send for a new thread carries sessionId: undefined.
    const lastCall = sendChat.mock.calls.at(-1)!;
    expect(lastCall[0]).toBe("investigate this warning");
    expect((lastCall[1] as { sessionId?: string }).sessionId).toBeUndefined();
  });
});
