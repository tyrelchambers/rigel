/**
 * Headless, room-scoped effects that must outlive the popover: publish the
 * active context, prime the worker's STT with the cluster's resource names,
 * resolve spoken resource names against the live store and publish each new
 * match's one-line summary to the worker, record turns into chat history, and
 * hand the worker's proposed mutations up to VoiceControl. Mounted next to
 * RoomAudioRenderer.
 */
import { useCallback, useEffect, useRef } from "react";
import type { Room } from "livekit-client";
import { useDataChannel, useTranscriptions, type AgentState } from "@livekit/components-react";
import type { ActionBlock } from "@/lib/api";
import { useCluster } from "@/store/cluster";
import { buildMentions, type MentionCandidate } from "@/panels/chat/mentions";
import { upsertSession } from "@/panels/chat/chatHistory";
import { voiceKeytermNames } from "./keyterms";
import { matchTranscript } from "./transcriptMatch";
import { toHistoryEntry, type VoiceSegment } from "./voiceHistory";

/** The agent's identity, minted by the server in voiceRoutes.identityFor. */
export const AGENT_IDENTITY_PREFIX = "rigel-agent";

export const ACTION_TOPIC = "rigel.action";
export const ACTION_RESULT_TOPIC = "rigel.action.result";

/** The worker's own state channel, published by apps/voice/src/lifecycle.ts. */
export const AGENT_STATE_TOPIC = "rigel.agent.state";

/** The five states an AgentSession reports, a subset of the SDK's AgentState.
 * Anything else on the wire is not a state this session can be in. */
const REPORTED_STATES: readonly string[] = ["initializing", "idle", "listening", "thinking", "speaking"];

export function toReportedAgentState(body: unknown): AgentState | null {
  if (!body || typeof body !== "object") return null;
  const state = (body as { state?: unknown }).state;
  return typeof state === "string" && REPORTED_STATES.includes(state) ? (state as AgentState) : null;
}

/** Every resource named this session is listed, so the bound is a runaway
 *  guard rather than a display cap. */
const MAX_PILLS = 60;

/** A mutation the worker proposed, exactly as it arrives on `rigel.action`. */
export interface VoiceActionFrame {
  id: string;
  action: ActionBlock;
  /** True when the worker is running it on the operator's instruction, rather
   *  than asking them to approve it. Non-destructive kinds only. */
  auto?: boolean;
  /**
   * Null for purge, applyManifest and proposeRepoFix: /api/action cannot
   * preview those three, so the worker skips the preview and the ConfirmSheet
   * rebuilds the command from the action block itself.
   */
  command: string | null;
  done?: { ok: boolean; summary: string };
}

/** A frame plus renderer-only state, which does not cross the wire. */
export interface VoiceAction extends VoiceActionFrame {
  unreported?: string;
}

/**
 * The slice of `@livekit/components-core`'s ReceivedDataMessage this file uses.
 * That package is only a transitive dependency, so the shape is restated rather
 * than imported.
 */
interface VoiceDataMessage {
  payload: Uint8Array;
  topic?: string;
  from?: { identity: string };
}

/**
 * Returns the promise so a caller that must not lose the frame can await it.
 * publishData rejects on an oversize packet (64,000 bytes for the whole
 * packet), which is silent otherwise.
 */
export function publishJson(room: Room, topic: string, payload: unknown): Promise<void> {
  return room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(payload)), {
    reliable: true,
    topic,
  });
}

/** Validates a decoded worker frame into something the popover can render. */
export function toVoiceActionFrame(topic: string | undefined, body: unknown): VoiceActionFrame | null {
  if (!body || typeof body !== "object") return null;
  const m = body as Record<string, unknown>;
  if (typeof m.id !== "string") return null;
  if (topic === ACTION_RESULT_TOPIC) {
    return {
      id: m.id,
      action: { kind: "" },
      command: null,
      done: { ok: m.ok === true, summary: typeof m.summary === "string" ? m.summary : "" },
    };
  }
  if (topic !== ACTION_TOPIC) return null;
  if (!m.action || typeof m.action !== "object") return null;
  const action = m.action as ActionBlock;
  if (typeof action.kind !== "string") return null;
  return {
    id: m.id,
    action,
    command: typeof m.command === "string" ? m.command : null,
    ...(m.auto === true ? { auto: true } : {}),
  };
}

export function VoiceSessionEffects({
  room,
  onPills,
  onAction,
  onAgentState,
}: {
  room: Room;
  onPills: (pills: MentionCandidate[]) => void;
  onAction: (frame: VoiceActionFrame) => void;
  onAgentState: (state: AgentState) => void;
}) {
  const transcriptions = useTranscriptions();
  const publishedIds = useRef(new Set<string>());
  const pillsRef = useRef<MentionCandidate[]>([]);
  const sessionIdRef = useRef(`voice-${crypto.randomUUID()}`);
  const startedAtRef = useRef(Date.now());
  const recordedRef = useRef<string | null>(null);
  const keytermsRef = useRef<string | null>(null);

  // Pills belong to a session, but they are held above this component so they
  // survive the popover. Ending one session and starting another mounts a new
  // instance, which is where they have to be dropped.
  useEffect(() => {
    publishedIds.current = new Set();
    pillsRef.current = [];
    onPills([]);
  }, [room, onPills]);

  useEffect(() => {
    const publish = () => void publishJson(room, "rigel.state", { activeContext: useCluster.getState().activeContext });
    publish();
    return useCluster.subscribe((s, prev) => {
      if (s.activeContext !== prev.activeContext) publish();
    });
  }, [room]);

  useEffect(() => {
    keytermsRef.current = null;
    const publish = () => {
      const names = voiceKeytermNames(buildMentions(useCluster.getState().resources));
      const signature = names.join("\u0000");
      if (signature === keytermsRef.current) return;
      keytermsRef.current = signature;
      void publishJson(room, "rigel.keyterms", { names });
    };
    publish();
    return useCluster.subscribe((s, prev) => {
      if (s.resources !== prev.resources) publish();
    });
  }, [room]);

  const handleFrame = useCallback(
    (msg: VoiceDataMessage) => {
      // Only the worker may drive this popover. Holding a room token is not
      // authorization: any other participant able to publish data could
      // otherwise raise a ConfirmSheet on the operator's desktop, pre-filled
      // with an action of their choosing. An unresolved sender arrives as
      // undefined rather than a raw wire identity, so this fails closed.
      if (!(msg.from?.identity ?? "").startsWith(AGENT_IDENTITY_PREFIX)) return;
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(msg.payload));
      } catch {
        return;
      }
      const frame = toVoiceActionFrame(msg.topic, body);
      if (frame) onAction(frame);
    },
    [onAction],
  );
  useDataChannel(ACTION_TOPIC, handleFrame);
  useDataChannel(ACTION_RESULT_TOPIC, handleFrame);

  // Same sender check as the action frames, for the same reason: this drives
  // what the popover tells the operator the assistant is doing, and an
  // unresolved sender must not be able to say it is listening.
  useDataChannel(
    AGENT_STATE_TOPIC,
    useCallback(
      (msg: VoiceDataMessage) => {
        if (!(msg.from?.identity ?? "").startsWith(AGENT_IDENTITY_PREFIX)) return;
        let body: unknown;
        try {
          body = JSON.parse(new TextDecoder().decode(msg.payload));
        } catch {
          return;
        }
        const state = toReportedAgentState(body);
        if (state) onAgentState(state);
      },
      [onAgentState],
    ),
  );

  useEffect(() => {
    const candidates = buildMentions(useCluster.getState().resources);
    let changed = false;
    // Interim results rewrite the tail entry in place, so the whole array is
    // rescanned each tick; publishedIds is what keeps that idempotent.
    for (const t of transcriptions) {
      if ((t.participantInfo?.identity ?? "").startsWith(AGENT_IDENTITY_PREFIX)) continue;
      for (const m of matchTranscript(t.text, candidates)) {
        if (publishedIds.current.has(m.id)) continue;
        publishedIds.current.add(m.id);
        void publishJson(room, "rigel.context", { id: m.id, context: m.context });
        pillsRef.current = [...pillsRef.current, m].slice(-MAX_PILLS);
        changed = true;
      }
    }
    if (changed) onPills(pillsRef.current);
  }, [transcriptions, room, onPills]);

  useEffect(() => {
    // Only "lk.transcription_final" === "true" segments are done; everything
    // else is STT still revising the same segment in place.
    const finals: VoiceSegment[] = transcriptions
      .filter((t) => t.streamInfo?.attributes?.["lk.transcription_final"] === "true")
      .map((t) => ({
        id: t.streamInfo?.id ?? crypto.randomUUID(),
        text: t.text,
        fromAgent: (t.participantInfo?.identity ?? "").startsWith(AGENT_IDENTITY_PREFIX),
      }));
    if (finals.length === 0) return;
    // toHistoryEntry rebuilds the whole session's messages from every final
    // seen so far, so upsertSession overwrites rather than appends; the
    // signature guard below just skips the redundant write when nothing new
    // finalized since the last tick.
    const signature = finals.map((f) => `${f.id}:${f.text}`).join("|");
    if (signature === recordedRef.current) return;
    recordedRef.current = signature;
    upsertSession(toHistoryEntry(sessionIdRef.current, startedAtRef.current, finals, Date.now()));
  }, [transcriptions]);

  return null;
}
