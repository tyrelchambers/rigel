// Voice-vs-click routing for a proposed mutation. The kind table
// (isVoiceConfirmable) and the shared classifier (classifyTier, run on the exact
// previewed command) must BOTH agree it is reversible; the stricter verdict
// always wins, so this path can never be looser than the chat policy.
import { isVoiceConfirmable, type SuggestedAction } from "@rigel/k8s/src/actionBlocks";
import { classifyTier } from "@rigel/k8s/src/commandPolicy";
import type { PendingMutation } from "./state.js";

export const PENDING_TTL_MS = 45_000;

export type MutationRoute = { route: "voice" } | { route: "click" } | { route: "refuse"; reason: string };

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
  if (isVoiceConfirmable(action) && tier !== "destructive") return { route: "voice" };
  if (!desktopPresent) {
    return {
      route: "refuse",
      reason: "this operation is irreversible and needs a tap in the desktop app, and no desktop is connected",
    };
  }
  return { route: "click" };
}

export function isPendingLive(p: PendingMutation | null, now: number): p is PendingMutation {
  return p != null && now - p.armedAt <= PENDING_TTL_MS;
}
