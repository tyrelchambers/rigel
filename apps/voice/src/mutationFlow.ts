// Routing for a proposed mutation. Two gates, and the stricter one wins: the
// kind table (isAutoRunnable) and the classifier run on the exact previewed
// command. Nothing here listens for a spoken word; "run" means the operator
// asked for a non-destructive change and the agent carries it out.
import { isAutoRunnable, type SuggestedAction } from "@rigel/k8s/src/actionBlocks";
import { classifyTier } from "@rigel/k8s/src/commandPolicy";

export type MutationRoute = { route: "run" } | { route: "click" } | { route: "refuse"; reason: string };

export function decideMutationRoute(
  action: SuggestedAction,
  commandString: string,
  desktopPresent: boolean,
): MutationRoute {
  const { tier } = classifyTier(commandString);
  if (tier === "blocked") {
    return {
      route: "refuse",
      reason: "that command cannot run headless; use the app's port-forward feature",
    };
  }
  if (isAutoRunnable(action) && tier !== "destructive") return { route: "run" };
  if (!desktopPresent) {
    return {
      route: "refuse",
      reason: "this one needs your approval in the desktop app, and no desktop session is connected",
    };
  }
  return { route: "click" };
}
