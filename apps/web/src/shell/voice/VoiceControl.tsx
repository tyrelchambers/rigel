/**
 * Header entry point for voice: a 28px NO_DRAG button (three wavy circles)
 * plus the anchored popover. Room lifetime is owned here: a press on the mark
 * itself toggles the session (connect+open, or end+close, or cancel a
 * connect in flight), so a closed popover never leaves the mic hot. Other
 * ways the popover closes (Escape, an outside click, a nested dialog like
 * ConfirmSheet stealing focus) only hide it — the session outlives those.
 * Renders nothing unless the server reports the voice flag enabled.
 */
import { useCallback, useEffect, useState } from "react";
import { RoomAudioRenderer, RoomContext, useTrackVolume, useVoiceAssistant } from "@livekit/components-react";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useVoiceStatus, type ActionResult } from "@/lib/api";
import type { MentionCandidate } from "@/panels/chat/mentions";
import { VoiceMark, visualStateFor } from "./VoiceMark";
import { VoicePopoverBody } from "./VoicePopoverBody";
import { useMicTrackRef, useVoiceRoom, type VoiceConnection } from "./useVoiceRoom";
import {
  ACTION_RESULT_TOPIC,
  publishJson,
  VoiceSessionEffects,
  type VoiceAction,
  type VoiceActionFrame,
} from "./VoiceSessionEffects";

const MAX_ACTIONS = 5;

/** publishData rejects the whole packet over 64,000 bytes, and stderr is the
 *  only field here without a natural bound. */
const MAX_SUMMARY = 400;

export function resultSummary(result: ActionResult): { ok: boolean; summary: string } {
  const ok = result.code === 0;
  const summary = ok ? "ran" : (result.stderr.split("\n").find(Boolean) ?? "failed");
  return { ok, summary: summary.slice(0, MAX_SUMMARY) };
}

function LiveVoiceMark() {
  const { state, audioTrack } = useVoiceAssistant();
  const micLevel = useTrackVolume(useMicTrackRef());
  const agentLevel = useTrackVolume(audioTrack);
  const visual = visualStateFor(state, true);
  return <VoiceMark state={visual} level={visual === "speaking" ? agentLevel : micLevel} />;
}

export function notReadyMessage(configured: boolean, status: VoiceConnection): string {
  if (!configured) return "Add your LiveKit and OpenRouter keys in Settings to use voice.";
  if (status === "error") return "Could not connect. Check the voice keys in Settings and try again.";
  return "Connecting…";
}

/** What the header mark's next click will do. Reachable outside interactions
 * (a proposal's ConfirmSheet stealing focus, Escape, an outside click) close
 * the popover without ending the session, so this only switches to the
 * ending copy while the popover is open on a live or in-flight session. */
export function voiceButtonLabel(open: boolean, status: VoiceConnection): string {
  return open && (status === "connecting" || status === "connected") ? "End voice session" : "Voice assistant";
}

export function VoiceControl({ style }: { style?: React.CSSProperties }) {
  const { data } = useVoiceStatus();
  const { room, status, connect, disconnect } = useVoiceRoom();
  const [open, setOpen] = useState(false);
  const [pills, setPills] = useState<MentionCandidate[]>([]);
  const [actions, setActions] = useState<VoiceAction[]>([]);
  const [confirmAction, setConfirmAction] = useState<VoiceAction | null>(null);

  // Proposals belong to a session. Pills are dropped by VoiceSessionEffects
  // remounting; actions are held here, so they are dropped here.
  useEffect(() => {
    setActions([]);
    setConfirmAction(null);
  }, [room]);

  const onAction = useCallback((frame: VoiceActionFrame) => {
    setActions((prev) => {
      if (frame.done) return prev.map((a) => (a.id === frame.id ? { ...a, done: frame.done } : a));
      return [...prev.filter((a) => a.id !== frame.id), { ...frame, receivedAt: Date.now() }].slice(-MAX_ACTIONS);
    });
  }, []);

  const openSession = useCallback(() => {
    setOpen(true);
    if (data?.configured && (status === "idle" || status === "error")) void connect();
  }, [data?.configured, status, connect]);

  const closeSession = useCallback(() => {
    setOpen(false);
    if (status === "connecting" || status === "connected") disconnect();
  }, [status, disconnect]);

  const reportResult = useCallback(
    async (frame: VoiceAction, ok: boolean, summary: string) => {
      onAction({ ...frame, done: { ok, summary } });
      if (!room) return;
      try {
        await publishJson(room, ACTION_RESULT_TOPIC, { id: frame.id, ok, summary });
      } catch (err) {
        // The change already happened. A dropped result means the worker never
        // learns it, so the agent would go on to misreport the outcome.
        console.error("[voice] publishing the action result failed:", err);
        setActions((prev) =>
          prev.map((a) => (a.id === frame.id ? { ...a, unreported: "Ran, but the assistant was not told." } : a)),
        );
      }
    },
    [room, onAction],
  );

  if (!data?.enabled) return null;

  return (
    <>
      {room && (
        <RoomContext.Provider value={room}>
          <RoomAudioRenderer />
          <VoiceSessionEffects room={room} onPills={setPills} onAction={onAction} />
          <ConfirmSheet
            action={confirmAction?.action ?? null}
            open={confirmAction != null}
            onClose={() => setConfirmAction(null)}
            onPurge={() => {
              if (confirmAction) {
                void reportResult(confirmAction, false, "purge needs the typed-name confirmation in the app");
              }
            }}
            fromChat
            onResult={(info) => {
              if (!confirmAction) return;
              const { ok, summary } = resultSummary(info.result);
              void reportResult(confirmAction, ok, summary);
            }}
          />
        </RoomContext.Provider>
      )}
      <Popover
        open={open}
        onOpenChange={(o, eventDetails) => {
          // Only a press on our own mark drives the session: an outside
          // press or a nested dialog stealing focus (a proposal's
          // ConfirmSheet) also closes the popover, and must not hang up on
          // a session the user never asked to end.
          if (eventDetails.reason !== "trigger-press") {
            setOpen(o);
            return;
          }
          if (o) openSession();
          else closeSession();
        }}
      >
        <PopoverTrigger
          aria-label={voiceButtonLabel(open, status)}
          title={voiceButtonLabel(open, status)}
          style={{ ...style, background: "var(--surface-sunken)", borderColor: "var(--border-subtle)" }}
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full border transition-opacity hover:opacity-90"
        >
          {room ? (
            <RoomContext.Provider value={room}>
              <LiveVoiceMark />
            </RoomContext.Provider>
          ) : (
            <VoiceMark state="disconnected" level={0} />
          )}
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[380px] gap-0 overflow-hidden p-0">
          {room ? (
            <RoomContext.Provider value={room}>
              <VoicePopoverBody
                pills={pills}
                actions={actions}
                onRunClick={setConfirmAction}
                onEnd={closeSession}
              />
            </RoomContext.Provider>
          ) : (
            <span className="px-3.5 py-3 text-2xs" style={{ color: "var(--fg-secondary)" }}>
              {notReadyMessage(data.configured, status)}
            </span>
          )}
        </PopoverContent>
      </Popover>
    </>
  );
}
