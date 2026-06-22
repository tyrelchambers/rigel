// The catalogue of AI agents Rigel can drive. Pure data + lookups only — keep
// this free of heavy imports (claudeBridge/agentConfig) so nothing import-cycles
// through it. Only "claude" is wired to a real runner today (see runAgent.ts).

export type AgentId = "claude" | "codex" | "gemini" | "opencode" | "openrouter";
export type AgentAuthMethod = "subscription" | "apiKey";

export interface AgentDescriptor {
  id: AgentId;
  /** Product name, e.g. "Claude Code". */
  label: string;
  /** Vendor, e.g. "Anthropic". */
  vendor: string;
  /** "available" = has a real runner; "comingSoon" = listed but not runnable. */
  status: "available" | "comingSoon";
  /** Auth methods offered in the setup screen, in display order. */
  authMethods: AgentAuthMethod[];
  /** Step-1 "install / login" link. */
  installUrl: string;
  installLabel: string;
}

const AGENTS: AgentDescriptor[] = [
  {
    id: "claude",
    label: "Claude Code",
    vendor: "Anthropic",
    status: "available",
    authMethods: ["subscription", "apiKey"],
    installUrl: "https://docs.anthropic.com/en/docs/claude-code/overview",
    installLabel: "Install Claude Code",
  },
  {
    id: "codex",
    label: "Codex",
    vendor: "OpenAI",
    status: "available",
    authMethods: ["subscription", "apiKey"],
    installUrl: "https://github.com/openai/codex",
    installLabel: "Install Codex",
  },
  {
    id: "gemini",
    label: "Gemini",
    vendor: "Google",
    status: "comingSoon",
    authMethods: ["subscription", "apiKey"],
    installUrl: "https://github.com/google-gemini/gemini-cli",
    installLabel: "Install Gemini CLI",
  },
  {
    id: "opencode",
    label: "OpenCode",
    vendor: "OpenCode",
    status: "comingSoon",
    authMethods: ["subscription", "apiKey"],
    installUrl: "https://opencode.ai",
    installLabel: "Install OpenCode",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    vendor: "OpenRouter",
    status: "comingSoon",
    authMethods: ["apiKey"],
    installUrl: "https://openrouter.ai/keys",
    installLabel: "Get an OpenRouter key",
  },
];

export function listAgents(): AgentDescriptor[] {
  return AGENTS;
}

export function getAgent(id: string): AgentDescriptor | undefined {
  return AGENTS.find((a) => a.id === id);
}
