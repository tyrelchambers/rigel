// What happens around the edges of a desktop session. One worker process holds
// one AgentSession for the whole app run, so "a session" from the operator's
// point of view is really just the window between the desktop joining the room
// and leaving it, and both edges need work: the desktop has to be told what the
// agent is doing, and everything the last window accumulated has to be dropped.
import { llm, voice } from "@livekit/agents";
import { publishJson, type PublishRoom } from "./publish.js";
import { resetSessionState, type SessionState } from "./state.js";

/**
 * The worker's own state channel.
 *
 * The renderer prefers this over `useVoiceAssistant`, which finds the agent
 * only by `ParticipantKind.AGENT` and reads its state only from the
 * `lk.agent.state` participant attribute. Both are LiveKit server-side
 * mappings we do not control, neither is visible from our types, and the hook
 * has no failure state: when either link is missing it reports "connecting"
 * for as long as the room is up. This channel is ours end to end.
 */
export const AGENT_STATE_TOPIC = "rigel.agent.state";

/** The subset of the Agent the desktop's departure touches. */
export interface ScrubbableAgent {
  updateChatCtx(chatCtx: llm.ChatContext): Promise<void>;
}

/** The subset of the AgentSession the desktop's departure touches. */
export interface InterruptibleSession {
  interrupt(options?: { force?: boolean }): unknown;
}

/**
 * Tells the desktop what the agent is doing. Sent on every transition and again
 * whenever the desktop joins, because the worker has usually been sitting in
 * the room since app start and the channel would otherwise stay silent until
 * the next transition, which is exactly the state the desktop is waiting for.
 */
export function announceAgentState(room: PublishRoom, state: voice.AgentState): Promise<void> {
  return publishJson(room, AGENT_STATE_TOPIC, { state });
}

/**
 * Ends a desktop session without ending the AgentSession. Drops the spoken
 * context and any armed mutation (see resetSessionState) and empties the chat
 * history, so the next connection starts on a blank agent rather than resuming
 * a conversation whose other half has gone.
 *
 * Stopping the speech is part of that and used to be missing. One AgentSession
 * runs for the life of the worker, so a reply already being spoken went on
 * being spoken into a room the operator had left, and the next connection
 * picked it up mid-sentence: closing the window looked like it had done
 * nothing. Interrupting is best-effort, because there is usually nothing being
 * said and the session is entitled to say so.
 */
export async function endDesktopSession(
  state: SessionState,
  agent: ScrubbableAgent,
  session: InterruptibleSession,
): Promise<void> {
  try {
    session.interrupt();
  } catch (err) {
    console.error("interrupting the agent as the desktop left failed:", err);
  }
  resetSessionState(state);
  await agent.updateChatCtx(llm.ChatContext.empty());
}
