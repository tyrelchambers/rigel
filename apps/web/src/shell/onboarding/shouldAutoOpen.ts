import type { AgentsResponse } from "@/lib/api";

/** True when the active agent (any backend) reports a live connection. */
export function activeAgentConnected(agents: AgentsResponse | undefined): boolean {
  if (!agents) return false;
  const active = agents.agents.find((a) => a.id === agents.activeAgentId);
  return active?.connection === "connected";
}

/** Auto-open onboarding when no active agent is connected — keyed off the active agent, not the Claude token (HELM-12). */
export function shouldAutoOpenOnboarding(opts: {
  agents: AgentsResponse | undefined;
  onboarded: boolean;
}): boolean {
  if (!opts.agents) return false;
  if (opts.onboarded) return false;
  return !activeAgentConnected(opts.agents);
}
