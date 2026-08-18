/**
 * Headless, room-scoped effects that must outlive the popover: publish the
 * active context, prime the worker's STT with the cluster's resource names,
 * resolve spoken resource names against the live store and publish each new
 * match's one-line summary to the worker, and record turns into chat history
 * (Task 11). Mounted next to RoomAudioRenderer.
 */
import { useEffect, useRef } from "react";
import type { Room } from "livekit-client";
import { useTranscriptions } from "@livekit/components-react";
import { useCluster } from "@/store/cluster";
import { buildMentions, type MentionCandidate } from "@/panels/chat/mentions";
import { upsertSession } from "@/panels/chat/chatHistory";
import { voiceKeytermNames } from "./keyterms";
import { matchTranscript } from "./transcriptMatch";
import { toHistoryEntry, type VoiceSegment } from "./voiceHistory";

/** The agent's identity, minted by the server in voiceRoutes.identityFor. */
export const AGENT_IDENTITY_PREFIX = "rigel-agent";

const MAX_PILLS = 6;

export function publishJson(room: Room, topic: string, payload: unknown): void {
  void room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(payload)), {
    reliable: true,
    topic,
  });
}

export function VoiceSessionEffects({
  room,
  onPills,
}: {
  room: Room;
  onPills: (pills: MentionCandidate[]) => void;
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
    const publish = () => publishJson(room, "rigel.state", { activeContext: useCluster.getState().activeContext });
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
      publishJson(room, "rigel.keyterms", { names });
    };
    publish();
    return useCluster.subscribe((s, prev) => {
      if (s.resources !== prev.resources) publish();
    });
  }, [room]);

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
        publishJson(room, "rigel.context", { id: m.id, context: m.context });
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
