import { describe, it, expect } from "vitest";
import type { AgentsResponse, AgentView } from "@/lib/api";
import { activeAgentConnected, shouldAutoOpenOnboarding } from "./shouldAutoOpen";

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

const notConnected: AgentsResponse = { activeAgentId: "claude", agents: [claude, codex] };
const codexActive: AgentsResponse = { activeAgentId: "codex", agents: [claude, codex] };

describe("activeAgentConnected", () => {
  it("is false when agents are undefined (still loading)", () => {
    expect(activeAgentConnected(undefined)).toBe(false);
  });
  it("is true when the ACTIVE agent is connected, even if it isn't Claude", () => {
    expect(activeAgentConnected(codexActive)).toBe(true);
  });
  it("is false when the active agent is not connected", () => {
    expect(activeAgentConnected(notConnected)).toBe(false);
  });
  it("is false when the active id matches no agent", () => {
    expect(activeAgentConnected({ activeAgentId: "gemini", agents: [claude, codex] })).toBe(false);
  });
});

describe("shouldAutoOpenOnboarding", () => {
  it("does NOT open while the account gate is unresolved", () => {
    expect(shouldAutoOpenOnboarding({ accountMissing: null, agents: notConnected, onboarded: false })).toBe(false);
    expect(shouldAutoOpenOnboarding({ accountMissing: true, agents: notConnected, onboarded: false })).toBe(false);
  });
  it("does NOT open while agents are still loading", () => {
    expect(shouldAutoOpenOnboarding({ accountMissing: false, agents: undefined, onboarded: false })).toBe(false);
  });
  it("does NOT open once the user has been onboarded", () => {
    expect(shouldAutoOpenOnboarding({ accountMissing: false, agents: notConnected, onboarded: true })).toBe(false);
  });
  it("opens when the account gate cleared, agents loaded, and no agent is connected", () => {
    expect(shouldAutoOpenOnboarding({ accountMissing: false, agents: notConnected, onboarded: false })).toBe(true);
  });
  it("does NOT open for a connected Codex-only user (the HELM-12 bug)", () => {
    expect(shouldAutoOpenOnboarding({ accountMissing: false, agents: codexActive, onboarded: false })).toBe(false);
  });
});
