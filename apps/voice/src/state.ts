import { buildKeyterms, sameKeyterms } from "./keyterms.js";
import type { VoiceClient } from "./publish.js";

/** Mutable per-session state, shared by the tools and the turn hook. */
export interface SessionState {
  activeContext: string | null;
  contextLines: string[];
  /**
   * Proposals sent to the desktop, by tool-call id, holding the label to speak
   * when the desktop reports back. It is the worker's only record of one: the
   * agent is not the thing that runs a mutation.
   */
  awaitingClick: Map<string, string>;
  /** The STT keyterm list: static vocabulary plus the live cluster's names. */
  keyterms: string[];
}

export function emptySessionState(activeContext: string | null = null): SessionState {
  return {
    activeContext,
    contextLines: [],
    awaitingClick: new Map(),
    keyterms: buildKeyterms([]),
  };
}

/** What a frame moved, so the caller can re-issue only what actually changed. */
export interface FrameEffect {
  contextChanged: boolean;
  keytermsChanged: boolean;
  /** A line the agent must speak, or null. Set only by a desktop result. */
  speak: string | null;
}

const NO_EFFECT: FrameEffect = { contextChanged: false, keytermsChanged: false, speak: null };

/**
 * Only the room's own client may steer worker state. Anyone else holding a
 * valid room token cannot authorize a control frame by possession alone: a
 * forged rigel.state would repoint every subsequent read and mutation at a
 * different cluster.
 *
 * Reports what the frame moved: `contextChanged` re-issues the agent's
 * instructions, `keytermsChanged` re-primes the STT, `speak` is the line the
 * agent owes the operator about a click-tier change they just ran.
 */
export function applyDataFrame(
  state: SessionState,
  client: VoiceClient,
  identity: string | undefined,
  topic: string | undefined,
  raw: string,
): FrameEffect {
  if (identity !== client.clientIdentity) return NO_EFFECT;
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
