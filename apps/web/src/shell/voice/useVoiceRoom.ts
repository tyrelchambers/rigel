import { useCallback, useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track } from "livekit-client";
import {
  useLocalParticipant,
  useVoiceAssistant,
  type AgentState,
  type TrackReference,
} from "@livekit/components-react";
import { fetchVoiceToken } from "@/lib/api";
import { effectiveAgentState, type AgentReport } from "./VoiceMark";

export type VoiceConnection = "idle" | "connecting" | "connected" | "error";

/** Why the last attempt failed. Separate from `status` because the two
 * failures send the user to opposite places: one to the OS, one to Settings. */
export type VoiceFailure = "mic-denied" | "connect";

/**
 * The connection machinery's own state, as opposed to the `status` the popover
 * renders. Exactly one of the three holds at any moment, so a fast
 * close/reopen cannot land between two independent flags: the pair of silent
 * dead-ends this replaces were both "the popover says connecting and nothing
 * is connecting".
 *
 * `cancelled` lives on the in-flight attempt rather than beside it, which is
 * what lets a reopened popover re-arm the very attempt it just cancelled
 * instead of racing a second one against it.
 */
type Phase =
  | { kind: "off" }
  | { kind: "connecting"; cancelled: boolean }
  | { kind: "live"; room: Room; detach: () => void };

type Attempt = Extract<Phase, { kind: "connecting" }>;

/**
 * getUserMedia's rejection arrives here unwrapped: livekit-client's
 * `setTrackEnabled` rethrows the original DOMException rather than wrapping
 * it, so the DOM error name is the only thing to key on. Both spellings are
 * the ones livekit's own `MediaDeviceFailure.getFailure` maps to
 * PermissionDenied.
 */
export function isMicDenied(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "NotAllowedError" || name === "PermissionDeniedError";
}

/** Owns the renderer's LiveKit room: connect on demand, publish the mic, stay
 * connected while the popover is closed, disconnect on End.
 *
 * The phase only reaches "live" once connect and mic-enable have both
 * succeeded, never earlier: that's what lets `disconnect()` tell "there is a
 * live Room to hang up on" apart from "an attempt is still in flight", and
 * cancel the latter instead of racing `Room.disconnect()` against
 * `Room.connect()` on the same instance. */
export function useVoiceRoom() {
  const phaseRef = useRef<Phase>({ kind: "off" });
  const mountedRef = useRef(true);
  const [room, setRoom] = useState<Room | null>(null);
  const [status, setStatus] = useState<VoiceConnection>("idle");
  const [failure, setFailure] = useState<VoiceFailure | null>(null);

  const connect = useCallback(async () => {
    const phase = phaseRef.current;
    if (phase.kind === "live") return;
    if (phase.kind === "connecting") {
      // Re-arm the attempt already in flight instead of starting a second one.
      // Nothing awaits between an attempt reading `cancelled` and this phase
      // ending, so a phase still reading "connecting" means that read is still
      // ahead of us. A second attempt would also join the room twice under the
      // one desktop identity.
      phase.cancelled = false;
      if (mountedRef.current) {
        setFailure(null);
        setStatus("connecting");
      }
      return;
    }
    const attempt: Attempt = { kind: "connecting", cancelled: false };
    phaseRef.current = attempt;
    if (mountedRef.current) {
      setFailure(null);
      setStatus("connecting");
    }
    let r: Room | null = null;
    const onDisconnected = () => {
      const current = phaseRef.current;
      // Only the room we are currently holding may end the session. A room we
      // already hung up on, or a failed attempt's half-built one, fires this
      // a turn later and would otherwise tear down whatever replaced it.
      if (current.kind !== "live" || current.room !== r) return;
      phaseRef.current = { kind: "off" };
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
      const live = r;
      if (attempt.cancelled) {
        phaseRef.current = { kind: "off" };
        live.off(RoomEvent.Disconnected, onDisconnected);
        void live.disconnect();
        return;
      }
      phaseRef.current = {
        kind: "live",
        room: live,
        detach: () => live.off(RoomEvent.Disconnected, onDisconnected),
      };
      if (mountedRef.current) {
        setRoom(live);
        setStatus("connected");
      }
    } catch (err) {
      // Leave the phase first: tearing down a half-connected room fires
      // Disconnected, and that handler would overwrite "error" with "idle".
      phaseRef.current = { kind: "off" };
      r?.off(RoomEvent.Disconnected, onDisconnected);
      void r?.disconnect();
      if (mountedRef.current && !attempt.cancelled) {
        setRoom(null);
        setFailure(isMicDenied(err) ? "mic-denied" : "connect");
        setStatus("error");
      }
    }
  }, []);

  const disconnect = useCallback(() => {
    const phase = phaseRef.current;
    if (phase.kind === "connecting") {
      phase.cancelled = true;
      if (mountedRef.current) setStatus("idle");
      return;
    }
    if (phase.kind !== "live") return;
    // Drop the room here rather than waiting for RoomEvent.Disconnected, which
    // lands a turn later: reopening inside that window used to find a status of
    // "connected", skip the reconnect, and then be knocked to "idle" by the
    // event with nothing in flight.
    phaseRef.current = { kind: "off" };
    phase.detach();
    void phase.room.disconnect();
    if (mountedRef.current) {
      setRoom(null);
      setStatus("idle");
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const phase = phaseRef.current;
      if (phase.kind === "connecting") phase.cancelled = true;
      if (phase.kind === "live") {
        phaseRef.current = { kind: "off" };
        phase.detach();
        void phase.room.disconnect();
      }
    };
  }, []);

  return { room, status, failure, connect, disconnect };
}

/** The local mic as a TrackReference, which is what the volume hooks want.
 * Undefined until the publication exists. Requires a RoomContext. */
export function useMicTrackRef(): TrackReference | undefined {
  const { microphoneTrack, localParticipant } = useLocalParticipant();
  if (!microphoneTrack) return undefined;
  return { participant: localParticipant, publication: microphoneTrack, source: Track.Source.Microphone };
}

/**
 * How long a live room may go without the worker saying what the agent is doing
 * before the popover calls it unavailable. The worker joins the room at app
 * start and replies to a desktop joining immediately, so the only case that
 * legitimately runs long is opening voice while the worker is still booting.
 * Not terminal either way: a report arriving later takes over.
 */
export const AGENT_REPORT_TIMEOUT_MS = 15_000;

/** Tracks the worker's reports for one room, and how long the silence has run.
 * Both reset when the room does, since a report belongs to a session. */
export function useAgentReport(room: Room | null): {
  report: AgentReport;
  onAgentState: (state: AgentState) => void;
} {
  const [state, setState] = useState<AgentState | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    setState(null);
    setTimedOut(false);
    if (!room) return;
    const id = setTimeout(() => setTimedOut(true), AGENT_REPORT_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [room]);
  return { report: { state, timedOut }, onAgentState: setState };
}

/** The assistant state the UI should render, plus the agent's audio track.
 * useVoiceAssistant stays the source for the track: the waveform needs the
 * real published audio, which no data frame can stand in for. Requires a
 * RoomContext. */
export function useAssistantState(report: AgentReport): {
  state: AgentState;
  audioTrack: TrackReference | undefined;
} {
  const { state, audioTrack } = useVoiceAssistant();
  return { state: effectiveAgentState(report, state), audioTrack };
}
