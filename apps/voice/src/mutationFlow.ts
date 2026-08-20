// Routing for a proposed mutation. Every mutation needs a tap in the desktop
// app: a spoken word is not a confirmation, because anyone within earshot can
// say it. The classifier still runs on the exact previewed command, so a
// command that cannot run headless is refused before it is ever offered.
import { classifyTier } from "@rigel/k8s/src/commandPolicy";

export type MutationRoute = { route: "click" } | { route: "refuse"; reason: string };

export function decideMutationRoute(commandString: string, desktopPresent: boolean): MutationRoute {
  const { tier } = classifyTier(commandString);
  if (tier === "blocked") {
    return {
      route: "refuse",
      reason: "that command cannot run headless; use the app's port-forward feature",
    };
  }
  if (!desktopPresent) {
    return {
      route: "refuse",
      reason: "every change needs a tap in the desktop app, and no desktop session is connected",
    };
  }
  return { route: "click" };
}
