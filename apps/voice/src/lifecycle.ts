// What happens around the edges of a session. Every client connection gets its
// own room and its own AgentSession, so both edges need work: the client has to
// be told what the agent is doing, and once the client is gone the session and
// the room have to go with it.
import type { VoiceJob } from "@rigel/server/src/voiceDispatch";
import { voice } from "@livekit/agents";
import { DisconnectReason } from "@livekit/rtc-node";
import { publishJson, type PublishRoom, type VoiceClient } from "./publish.js";

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

export const CLIENT_JOIN_TIMEOUT_MS = 30_000;
export const CLIENT_REJOIN_GRACE_MS = 20_000;

/**
 * Tells the client what the agent is doing. Sent on every transition and again
 * whenever the client joins, because the channel would otherwise stay silent
 * until the next transition, which is exactly the state the client is waiting
 * for.
 */
export function announceAgentState(room: PublishRoom, client: VoiceClient, state: voice.AgentState): Promise<void> {
  return publishJson(room, client, AGENT_STATE_TOPIC, { state });
}

export interface SupervisedRoom {
  remoteParticipants: Map<string, { identity: string }>;
  on(event: "participantConnected", listener: (participant: { identity: string }) => void): unknown;
  on(
    event: "participantDisconnected",
    listener: (participant: { identity: string; disconnectReason?: DisconnectReason }) => void,
  ): unknown;
  on(event: "disconnected", listener: () => void): unknown;
  disconnect(): Promise<void>;
}

export interface ClosableSession {
  readonly _closing: boolean;
  close(): Promise<void>;
  on(event: voice.AgentSessionEventTypes.Close, listener: () => void): unknown;
}

export function superviseSession(
  sessions: Map<string, () => Promise<void>>,
  job: Pick<VoiceJob, "room" | "clientIdentity">,
  room: SupervisedRoom,
  session: ClosableSession,
  joinTimeoutMs = CLIENT_JOIN_TIMEOUT_MS,
): () => Promise<void> {
  let ending = false;
  let ended: Promise<void> = Promise.resolve();
  let clientTimer: ReturnType<typeof setTimeout> | undefined;
  const teardown = () => {
    if (ending) return ended;
    ending = true;
    clearTimeout(clientTimer);
    ended = (async () => {
      try {
        if (!session._closing) await session.close();
      } catch (err) {
        console.error(`${job.room}: closing the session failed:`, err);
      }
      try {
        await room.disconnect();
      } catch (err) {
        console.error(`${job.room}: leaving the room failed:`, err);
      }
      sessions.delete(job.room);
      console.log(`${job.room}: session ended`);
    })();
    return ended;
  };
  const awaitClient = (ms: number, why: string) => {
    clearTimeout(clientTimer);
    clientTimer = setTimeout(() => {
      console.log(`${job.room}: ${job.clientIdentity} ${why}`);
      void teardown();
    }, ms);
  };

  if (!room.remoteParticipants.has(job.clientIdentity)) awaitClient(joinTimeoutMs, "never joined");
  room.on("participantConnected", (participant) => {
    if (participant.identity === job.clientIdentity) clearTimeout(clientTimer);
  });
  room.on("participantDisconnected", (participant) => {
    if (participant.identity !== job.clientIdentity) return;
    if (participant.disconnectReason === DisconnectReason.DUPLICATE_IDENTITY) return;
    if (participant.disconnectReason === DisconnectReason.CLIENT_INITIATED) {
      console.log(`${job.room}: ${job.clientIdentity} left`);
      void teardown();
      return;
    }
    console.log(`${job.room}: ${job.clientIdentity} dropped (reason ${participant.disconnectReason ?? "unknown"})`);
    awaitClient(CLIENT_REJOIN_GRACE_MS, "never came back");
  });
  room.on("disconnected", () => {
    void teardown();
  });
  session.on(voice.AgentSessionEventTypes.Close, () => {
    void teardown();
  });

  sessions.set(job.room, teardown);
  return teardown;
}
