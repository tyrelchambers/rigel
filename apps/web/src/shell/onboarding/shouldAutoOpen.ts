import type { AgentsResponse } from "@/lib/api";

/** True when the active agent (any backend) reports a live connection. */
export function activeAgentConnected(agents: AgentsResponse | undefined): boolean {
  if (!agents) return false;
  const active = agents.agents.find((a) => a.id === agents.activeAgentId);
  return active?.connection === "connected";
}

/**
 * Decide whether first-run onboarding should auto-open. Keyed off the ACTIVE
 * AGENT, not the Claude token: a connected Codex-only user must not trip it
 * (HELM-12). Opens once when the account gate has cleared, agents have loaded,
 * no agent is connected, and the user hasn't already been onboarded.
 */
export function shouldAutoOpenOnboarding(opts: {
  accountMissing: boolean | null;
  agents: AgentsResponse | undefined;
  onboarded: boolean;
}): boolean {
  if (opts.accountMissing !== false) return false;
  if (!opts.agents) return false;
  if (opts.onboarded) return false;
  return !activeAgentConnected(opts.agents);
}
