import type { SuggestedAction } from "@rigel/k8s/src/actionBlocks";
import { buildKeyterms, sameKeyterms } from "./keyterms.js";

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
  /**
   * Click-tier proposals sent to the desktop, by tool-call id, holding the
   * label to speak when the desktop reports back. The worker has no other
   * record of a click-tier proposal: unlike a voice-tier one it never lands in
   * `pending`, because the agent is not the thing that runs it.
   */
  awaitingClick: Map<string, string>;
  /** The STT keyterm list: static vocabulary plus the live cluster's names. */
  keyterms: string[];
}

export function emptySessionState(): SessionState {
  return {
    activeContext: null,
    contextLines: [],
    pending: null,
    awaitingClick: new Map(),
    keyterms: buildKeyterms([]),
  };
}

/**
 * Scrubs a finished session in place. The state object is captured by the
 * agent's tools and turn hook, so it is mutated rather than replaced.
 *
 * `pending` is the reason this exists: an armed mutation surviving into the
 * next session would let a reconnecting operator run a proposal they never
 * heard, just by saying "confirm". The rest goes with it because the desktop
 * republishes rigel.state and rigel.keyterms the moment it reconnects.
 */
export function resetSessionState(state: SessionState): void {
  state.activeContext = null;
  state.contextLines = [];
  state.pending = null;
  state.awaitingClick.clear();
  state.keyterms = buildKeyterms([]);
}

/** What a frame moved, so the caller can re-issue only what actually changed. */
export interface FrameEffect {
  contextChanged: boolean;
  keytermsChanged: boolean;
  /** A line the agent must speak, or null. Set only by a click-tier result. */
  speak: string | null;
}

const NO_EFFECT: FrameEffect = { contextChanged: false, keytermsChanged: false, speak: null };

/**
 * Only `DESKTOP_IDENTITY` may steer worker state. A phone participant holds a
 * valid room token, so possession alone cannot authorize a control frame: a
 * forged rigel.state would repoint every subsequent read and mutation at a
 * different cluster.
 *
 * Reports what the frame moved: `contextChanged` re-issues the agent's
 * instructions, `keytermsChanged` re-primes the STT, `speak` is the line the
 * agent owes the operator about a click-tier change they just ran.
 */
export function applyDataFrame(
  state: SessionState,
  identity: string | undefined,
  topic: string | undefined,
  raw: string,
): FrameEffect {
  if (identity !== DESKTOP_IDENTITY) return NO_EFFECT;
  try {
    const msg = JSON.parse(raw);
    if (topic === "rigel.state" && (typeof msg.activeContext === "string" || msg.activeContext === null)) {
      if (state.activeContext === msg.activeContext) return NO_EFFECT;
      state.activeContext = msg.activeContext;
      return { ...NO_EFFECT, contextChanged: true };
    }
    if (topic === "rigel.context" && typeof msg.context === "string") {
      if (!state.contextLines.includes(msg.context)) state.contextLines.push(msg.context);
    }
    if (topic === "rigel.keyterms" && Array.isArray(msg.names)) {
      const next = buildKeyterms(msg.names.filter((n: unknown) => typeof n === "string"));
      if (sameKeyterms(state.keyterms, next)) return NO_EFFECT;
      state.keyterms = next;
      return { ...NO_EFFECT, keytermsChanged: true };
    }
    // The desktop's verdict on a click-tier proposal. Without it the agent
    // never learns whether the operator ran the change or dismissed it, and
    // answers the next question as if the proposal were still outstanding.
    // An id we never proposed is ignored, which also drops the echo of the
    // worker's own voice-tier results.
    if (topic === "rigel.action.result" && typeof msg.id === "string") {
      // A voice-tier proposal cancelled from the popover. The slot has to be
      // disarmed here: otherwise the button only greys itself out locally and
      // a "confirm" spoken for any reason on the next turn still runs it.
      if (state.pending?.id === msg.id) {
        state.pending = null;
        return NO_EFFECT;
      }
      const label = state.awaitingClick.get(msg.id);
      if (label === undefined) return NO_EFFECT;
      state.awaitingClick.delete(msg.id);
      const summary = typeof msg.summary === "string" ? msg.summary : "";
      return {
        ...NO_EFFECT,
        speak: msg.ok === true ? `Done. ${label} completed.` : `That failed: ${summary || "unknown error"}.`,
      };
    }
  } catch {
    /* ignore malformed frames */
  }
  return NO_EFFECT;
}
