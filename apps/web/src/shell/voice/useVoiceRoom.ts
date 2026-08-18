import { useCallback, useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track } from "livekit-client";
import { useLocalParticipant, type TrackReference } from "@livekit/components-react";
import { fetchVoiceToken } from "@/lib/api";

export type VoiceConnection = "idle" | "connecting" | "connected" | "error";

/** Owns the renderer's LiveKit room: connect on demand, publish the mic, stay
 * connected while the popover is closed, disconnect on End.
 *
 * `roomRef` is only populated once connect/mic-enable both succeed, never
 * earlier: that's what lets `disconnect()` tell "there is a live Room to
 * hang up on" apart from "a connect attempt is still in flight", and route
 * the latter through `cancelledRef` instead of racing `Room.disconnect()`
 * against `Room.connect()` on the same instance. */
export function useVoiceRoom() {
  const roomRef = useRef<Room | null>(null);
  const connectingRef = useRef(false);
  const cancelledRef = useRef(false);
  const mountedRef = useRef(true);
  const [room, setRoom] = useState<Room | null>(null);
  const [status, setStatus] = useState<VoiceConnection>("idle");

  const connect = useCallback(async () => {
    if (roomRef.current || connectingRef.current) return;
    connectingRef.current = true;
    cancelledRef.current = false;
    setStatus("connecting");
    let r: Room | null = null;
    const onDisconnected = () => {
      roomRef.current = null;
      if (mountedRef.current) {
        setRoom(null);
        setStatus("idle");
      }
    };
    try {
      const { url, token } = await fetchVoiceToken();
      r = new Room();
      r.on(RoomEvent.Disconnected, onDisconnected);
      await r.connect(url, token);
      await r.localParticipant.setMicrophoneEnabled(true);
      if (cancelledRef.current) {
        r.off(RoomEvent.Disconnected, onDisconnected);
        void r.disconnect();
        return;
      }
      roomRef.current = r;
      if (mountedRef.current) {
        setRoom(r);
        setStatus("connected");
      }
    } catch {
      // Detach first: tearing down a half-connected room fires Disconnected,
      // and that handler would overwrite "error" with "idle".
      r?.off(RoomEvent.Disconnected, onDisconnected);
      void r?.disconnect();
      if (mountedRef.current && !cancelledRef.current) {
        setRoom(null);
        setStatus("error");
      }
    } finally {
      connectingRef.current = false;
    }
  }, []);

  const disconnect = useCallback(() => {
    if (roomRef.current) {
      void roomRef.current.disconnect();
      return;
    }
    if (connectingRef.current) {
      cancelledRef.current = true;
      if (mountedRef.current) setStatus("idle");
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelledRef.current = true;
      void roomRef.current?.disconnect();
    };
  }, []);

  return { room, status, connect, disconnect };
}

/** The local mic as a TrackReference, which is what the volume hooks want.
 * Undefined until the publication exists. Requires a RoomContext. */
export function useMicTrackRef(): TrackReference | undefined {
  const { microphoneTrack, localParticipant } = useLocalParticipant();
  if (!microphoneTrack) return undefined;
  return { participant: localParticipant, publication: microphoneTrack, source: Track.Source.Microphone };
}
