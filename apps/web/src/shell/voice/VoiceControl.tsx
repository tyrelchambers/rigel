/**
 * Header entry point for voice: a 28px NO_DRAG button (three wavy circles)
 * plus the anchored popover. Room lifetime is owned here so audio and (from
 * Phase 2) session effects survive the popover closing. Renders nothing unless
 * the server reports the voice flag enabled.
 */
import { useState } from "react";
import { RoomAudioRenderer, RoomContext, useTrackVolume, useVoiceAssistant } from "@livekit/components-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useVoiceStatus } from "@/lib/api";
import { VoiceMark, visualStateFor } from "./VoiceMark";
import { VoicePopoverBody } from "./VoicePopoverBody";
import { useMicTrackRef, useVoiceRoom, type VoiceConnection } from "./useVoiceRoom";
import { VoiceSessionEffects } from "./VoiceSessionEffects";

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

export function VoiceControl({ style }: { style?: React.CSSProperties }) {
  const { data } = useVoiceStatus();
  const { room, status, connect, disconnect } = useVoiceRoom();
  const [open, setOpen] = useState(false);
  if (!data?.enabled) return null;

  return (
    <>
      {room && (
        <RoomContext.Provider value={room}>
          <RoomAudioRenderer />
          <VoiceSessionEffects room={room} />
        </RoomContext.Provider>
      )}
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          // "error" reconnects too: reopening the popover is the retry the
          // failure copy promises.
          if (o && data.configured && (status === "idle" || status === "error")) void connect();
        }}
      >
        <PopoverTrigger
          aria-label="Voice assistant"
          title="Voice assistant"
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
                onEnd={() => {
                  disconnect();
                  setOpen(false);
                }}
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
