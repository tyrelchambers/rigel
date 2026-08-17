/**
 * Headless, room-scoped effects that must outlive the popover: publish the
 * active context to the worker, match transcripts to resources (Task 10), and
 * record turns into chat history (Task 11). Mounted next to RoomAudioRenderer.
 */
import { useEffect } from "react";
import type { Room } from "livekit-client";
import { useCluster } from "@/store/cluster";

export function publishJson(room: Room, topic: string, payload: unknown): void {
  void room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(payload)), {
    reliable: true,
    topic,
  });
}

export function VoiceSessionEffects({ room }: { room: Room }) {
  useEffect(() => {
    const publish = () => publishJson(room, "rigel.state", { activeContext: useCluster.getState().activeContext });
    publish();
    return useCluster.subscribe((s, prev) => {
      if (s.activeContext !== prev.activeContext) publish();
    });
  }, [room]);

  return null;
}
