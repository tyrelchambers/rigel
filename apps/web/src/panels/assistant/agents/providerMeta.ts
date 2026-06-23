// Pure provider metadata the Assistant Agents UI owns: the provider id list, the
// role defaults, and the provider→credential-key mapping. Vendor names, labels,
// and auth-method copy come from useAgents() at render time — this module only
// holds what the server does not surface.
import type { AgentId, AssistantCredentials, AssistantLimits, AssistantRoleSelection } from "@/lib/api";

/** The four providers, in display order. Mirrors the chat's AgentId set. */
export const PROVIDER_IDS: AgentId[] = ["claude", "codex", "gemini", "opencode"];

/** Out-of-box defaults — keep the fresh-install experience unchanged. */
export const DEFAULT_WORKER: AssistantRoleSelection = {
  provider: "claude",
  model: "claude-sonnet-4-6",
  effort: "high",
};
export const DEFAULT_SUPERVISOR: AssistantRoleSelection = {
  provider: "claude",
  model: "claude-opus-4-8",
  effort: "high",
};

/** Out-of-box operational limits — mirrors the server's DEFAULT_INSTALL_CONFIG (and
 *  the agent's Config defaults), so the Operational limits form shows the real values
 *  the agent uses rather than blanks when assistant-config hasn't overridden them. */
export const DEFAULT_LIMITS: AssistantLimits = {
  pollIntervalMs: 30000,
  maxPerResourcePerHour: 3,
  maxPerNight: 20,
  maxAttemptsPerIncident: 3,
  confirmPolls: 2,
  namespaces: [],
};

/** Every credential Secret key a provider can authenticate with. */
const KEYS_FOR: Record<AgentId, (keyof AssistantCredentials)[]> = {
  claude: ["claudeToken", "anthropicApiKey"],
  codex: ["codexApiKey"],
  gemini: ["geminiApiKey"],
  opencode: ["opencodeApiKey", "opencodeAuthContent"],
};

/** The PRIMARY credential key a pasted value for this provider writes to. */
export function credentialKeyFor(id: AgentId): keyof AssistantCredentials {
  return KEYS_FOR[id][0]!;
}

/** Reasoning effort applies only to Claude-family providers. */
export function isClaudeFamily(id: AgentId | string): boolean {
  return id === "claude";
}

/** True when at least one of the provider's credential keys has a non-empty value. */
export function credentialReady(id: AgentId, creds: AssistantCredentials | undefined): boolean {
  if (!creds) return false;
  return KEYS_FOR[id].some((k) => {
    const v = creds[k];
    return typeof v === "string" && v.trim() !== "";
  });
}
