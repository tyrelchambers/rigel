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
import { RoomAudioRenderer, RoomContext, useTrackVolume } from "@livekit/components-react";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useVoiceStatus, type ActionResult } from "@/lib/api";
import { useCommand } from "@/lib/shortcuts/useCommand";
import { VoiceMark, visualStateFor, type AgentReport } from "./VoiceMark";
import { VoicePopoverBody } from "./VoicePopoverBody";
import {
  useAgentReport,
  useAssistantState,
  useMicTrackRef,
  useVoiceRoom,
  type VoiceConnection,
  type VoiceFailure,
} from "./useVoiceRoom";
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

function LiveVoiceMark({ report }: { report: AgentReport }) {
  const { state, audioTrack } = useAssistantState(report);
  const micLevel = useTrackVolume(useMicTrackRef());
  const agentLevel = useTrackVolume(audioTrack);
  const visual = visualStateFor(state, true);
  return <VoiceMark state={visual} level={visual === "speaking" ? agentLevel : micLevel} />;
}

export function notReadyMessage(
  configured: boolean,
  status: VoiceConnection,
  failure: VoiceFailure | null,
): string {
  if (!configured) return "Add your LiveKit and OpenRouter keys in Settings to use voice.";
  if (status === "error") {
    return failure === "mic-denied"
      ? "Rigel needs microphone access. Allow it in your system settings, then try again."
      : "Could not connect. Check the voice keys in Settings and try again.";
  }
  return "Connecting…";
}

/** What the header mark's next click will do. A nested dialog taking focus (a
 * proposal's ConfirmSheet) closes the popover without ending the session, so
 * this only switches to the ending copy while the popover is open on a live or
 * in-flight session. */
export function voiceButtonLabel(open: boolean, status: VoiceConnection): string {
  return open && (status === "connecting" || status === "connected") ? "End voice session" : "Voice assistant";
}

export function voiceTogglePress(args: {
  open: boolean;
  confirming: boolean;
  openSession: () => void;
  closeSession: () => void;
}): void {
  if (args.confirming) return;
  if (args.open) args.closeSession();
  else args.openSession();
}

export function VoiceControl({ style }: { style?: React.CSSProperties }) {
  const { data } = useVoiceStatus();
  const { room, status, failure, connect, disconnect } = useVoiceRoom();
  const { report, onAgentState } = useAgentReport(room);
  const [open, setOpen] = useState(false);
  const [actions, setActions] = useState<VoiceAction[]>([]);
  const [confirmAction, setConfirmAction] = useState<VoiceAction | null>(null);

  // Proposals belong to a session, and they are held here rather than in
  // VoiceSessionEffects, so this is where a new room drops them.
  useEffect(() => {
    setActions([]);
    setConfirmAction(null);
  }, [room]);

  const onAction = useCallback((frame: VoiceActionFrame) => {
    setActions((prev) => {
      if (frame.done) return prev.map((a) => (a.id === frame.id ? { ...a, done: frame.done } : a));
      return [...prev.filter((a) => a.id !== frame.id), frame].slice(-MAX_ACTIONS);
    });
  }, []);

  // Neither of these consults `status`. It is a render-time copy of the
  // connection phase, and reading it here is exactly how a fast reopen used to
  // skip the reconnect; connect/disconnect each own the live phase and are
  // no-ops when there is nothing to do.
  const openSession = useCallback(() => {
    setOpen(true);
    if (data?.configured) void connect();
  }, [data?.configured, connect]);

  const closeSession = useCallback(() => {
    setOpen(false);
    disconnect();
  }, [disconnect]);

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

  useCommand(
    "voice.toggle",
    () => voiceTogglePress({ open, confirming: confirmAction != null, openSession, closeSession }),
    Boolean(data?.enabled),
  );

  if (!data?.enabled) return null;

  return (
    <>
      {room && (
        <RoomContext.Provider value={room}>
          <RoomAudioRenderer />
          <VoiceSessionEffects room={room} onAction={onAction} onAgentState={onAgentState} />
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
        onOpenChange={(o) => {
          if (o) {
            openSession();
            return;
          }
          // Closing the window is leaving, however it was closed: the mark, a
          // press outside, Escape. An agent that keeps talking to a window that
          // is not there is worse than having to say hello again.
          //
          // The exception is a proposal's ConfirmSheet, which takes focus and
          // closes the popover without the operator going anywhere. Hanging up
          // there would drop the room before the result could be published back
          // to the worker, so the sheet being up is what tells the two apart.
          if (confirmAction != null) {
            setOpen(false);
            return;
          }
          closeSession();
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
              <LiveVoiceMark report={report} />
            </RoomContext.Provider>
          ) : (
            <VoiceMark state="disconnected" level={0} />
          )}
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-[420px] gap-0 overflow-hidden rounded-xl p-0"
          style={{ borderColor: "var(--border-strong)" }}
        >
          {room ? (
            <RoomContext.Provider value={room}>
              <VoicePopoverBody
                report={report}
                actions={actions}
                onRunClick={setConfirmAction}
                onCancel={(a) => void reportResult(a, false, "cancelled")}
                onEnd={closeSession}
              />
            </RoomContext.Provider>
          ) : (
            <span className="px-3.5 py-3 text-2xs" style={{ color: "var(--fg-secondary)" }}>
              {notReadyMessage(data.configured, status, failure)}
            </span>
          )}
        </PopoverContent>
      </Popover>
    </>
  );
}
