/**
 * chatHandoffPrompts — helpers to build the standard Errors / Logs / Explain
 * (and Rollout for deployments) prompts for a given resource kind/name/namespace.
 *
 * These match the wording already established in DeploymentsPanel and are
 * extracted here so every list panel can produce consistent prompts without
 * duplicating the strings.
 */

export type ChatTopic = "Errors" | "Logs" | "Explain" | "Rollout";

/**
 * Build the Helmsman chat prompt for a given topic + resource.
 *
 * @param kind       - Kubernetes resource kind, lowercase (e.g. "deployment", "pod")
 * @param name       - Resource name
 * @param namespace  - Resource namespace (defaults to "default")
 * @param topic      - Which aspect to ask about
 */
export function buildHandoffPrompt(
  kind: string,
  name: string,
  namespace: string | undefined,
  topic: ChatTopic,
): string {
  const ns = namespace ?? "default";
  switch (topic) {
    case "Errors":
      return `Investigate errors on ${kind} ${name} in namespace ${ns} — check pod statuses, recent events, and crash/restart reasons.`;
    case "Logs":
      return `Show and summarize recent logs for ${kind} ${name} in namespace ${ns}.`;
    case "Explain":
      return `Explain what ${kind} ${name} in namespace ${ns} does and its current state.`;
    case "Rollout":
      return `Show the rollout status and recent rollout history of ${kind} ${name} in namespace ${ns}.`;
  }
}
