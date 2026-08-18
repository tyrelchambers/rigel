/**
 * Headless, room-scoped effects that must outlive the popover: publish the
 * active context, resolve spoken resource names against the live store and
 * publish each new match's one-line summary to the worker, and record turns
 * into chat history (Task 11). Mounted next to RoomAudioRenderer.
 */
import { useEffect, useRef } from "react";
import type { Room } from "livekit-client";
import { useTranscriptions } from "@livekit/components-react";
import { useCluster } from "@/store/cluster";
import { buildMentions, type MentionCandidate } from "@/panels/chat/mentions";
import { matchTranscript } from "./transcriptMatch";

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

  useEffect(() => {
    const publish = () => publishJson(room, "rigel.state", { activeContext: useCluster.getState().activeContext });
    publish();
    return useCluster.subscribe((s, prev) => {
      if (s.activeContext !== prev.activeContext) publish();
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

  return null;
}
