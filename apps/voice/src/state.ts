import type { SuggestedAction } from "@rigel/k8s/src/actionBlocks";

export const DESKTOP_IDENTITY = "rigel-desktop";

export interface PendingMutation {
  id: string;
  action: SuggestedAction;
  command: string;
  armedAt: number;
}

/** Mutable per-session state, shared by the tools and the turn hook. */
export interface SessionState {
  activeContext: string | null;
  contextLines: string[];
  pending: PendingMutation | null;
}

export function emptySessionState(): SessionState {
  return { activeContext: null, contextLines: [], pending: null };
}

/**
 * Only `DESKTOP_IDENTITY` may steer worker state. A phone participant holds a
 * valid room token, so possession alone cannot authorize a control frame: a
 * forged rigel.state would repoint every subsequent read and mutation at a
 * different cluster.
 *
 * Returns true when the frame moved `activeContext`, which the caller uses to
 * re-issue the agent's instructions.
 */
export function applyDataFrame(state: SessionState, identity: string | undefined, topic: string | undefined, raw: string): boolean {
  if (identity !== DESKTOP_IDENTITY) return false;
  try {
    const msg = JSON.parse(raw);
    if (topic === "rigel.state" && (typeof msg.activeContext === "string" || msg.activeContext === null)) {
      if (state.activeContext === msg.activeContext) return false;
      state.activeContext = msg.activeContext;
      return true;
    }
    if (topic === "rigel.context" && typeof msg.context === "string") {
      if (!state.contextLines.includes(msg.context)) state.contextLines.push(msg.context);
    }
  } catch {
    /* ignore malformed frames */
  }
  return false;
}
