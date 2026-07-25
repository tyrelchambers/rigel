import type { ClusterContext } from "@/lib/api";

/**
 * Auto-open onboarding until the user has both finished it and attached a
 * cluster. Keyed off contexts, not the AI agent: onboarding is now the single
 * first-run surface, and an app with no cluster has nothing to show.
 */
export function shouldAutoOpenOnboarding(opts: {
  contexts: ClusterContext[] | undefined;
  onboarded: boolean;
}): boolean {
  if (opts.contexts === undefined) return false; // still loading
  if (!opts.onboarded) return true;
  return opts.contexts.length === 0;
}
