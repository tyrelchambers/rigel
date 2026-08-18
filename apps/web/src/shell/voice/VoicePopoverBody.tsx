/**
 * Popover contents, top to bottom: state line, live waveform, rolling
 * transcript, and the resources the session has pinned. Must be rendered
 * inside a RoomContext.Provider.
 */
import {
  useMultibandTrackVolume,
  useTranscriptions,
  useVoiceAssistant,
  type AgentState,
} from "@livekit/components-react";
import { MENTION_KIND_LABEL, type MentionCandidate } from "@/panels/chat/mentions";
import { useMicTrackRef } from "./useVoiceRoom";
import { AGENT_IDENTITY_PREFIX } from "./VoiceSessionEffects";

// Exhaustive on purpose: a new AgentState in a future SDK should break the
// build rather than silently render the wrong label.
const STATE_LABEL: Record<AgentState, string> = {
  disconnected: "Connecting…",
  connecting: "Connecting…",
  "pre-connect-buffering": "Connecting…",
  initializing: "Connecting…",
  idle: "Listening",
  failed: "Agent unavailable",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
};

function Waveform() {
  const { state, audioTrack } = useVoiceAssistant();
  const micRef = useMicTrackRef();
  const bands = useMultibandTrackVolume(state === "speaking" ? audioTrack : micRef, { bands: 24 });
  return (
    <div className="flex h-10 items-end justify-center gap-[3px] px-3.5" aria-hidden>
      {bands.map((v, i) => (
        <div
          key={i}
          className="w-[4px] rounded-full"
          style={{
            height: `${Math.max(8, Math.min(100, v * 260))}%`,
            background: "var(--accent-primary)",
            opacity: 0.4 + Math.min(0.6, v * 2),
          }}
        />
      ))}
    </div>
  );
}

function Transcript() {
  const transcriptions = useTranscriptions();
  const recent = transcriptions.slice(-12);
  if (recent.length === 0) {
    return (
      <span className="px-3.5 py-2.5 text-2xs" style={{ color: "var(--fg-tertiary)" }}>
        Say something. Your words appear here as you speak.
      </span>
    );
  }
  return (
    <div className="flex max-h-52 flex-col gap-1.5 overflow-y-auto px-3.5 py-2.5">
      {recent.map((t, i) => {
        const fromAgent = (t.participantInfo?.identity ?? "").startsWith(AGENT_IDENTITY_PREFIX);
        return (
          <span
            key={t.streamInfo?.id ?? i}
            className={`max-w-[90%] rounded-lg px-2.5 py-1.5 text-xs ${fromAgent ? "self-start" : "self-end"}`}
            style={{
              background: fromAgent ? "var(--surface-sunken)" : "var(--accent-dim)",
              color: "var(--fg-primary)",
            }}
          >
            {t.text}
          </span>
        );
      })}
    </div>
  );
}

function Pills({ pills }: { pills: MentionCandidate[] }) {
  if (pills.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 border-t px-3.5 py-2.5" style={{ borderColor: "var(--border-subtle)" }}>
      {pills.map((p) => (
        <span
          key={p.id}
          className="inline-flex items-center gap-1.5 rounded px-2 py-0.5 font-mono text-3xs"
          style={{ background: "var(--surface-sunken)", color: "var(--fg-secondary)" }}
        >
          <span style={{ color: "var(--accent-primary)", fontWeight: 600, letterSpacing: 0.5 }}>{MENTION_KIND_LABEL[p.kind]}</span>
          {p.name}
        </span>
      ))}
    </div>
  );
}

export function VoicePopoverBody({ onEnd, pills }: { onEnd: () => void; pills: MentionCandidate[] }) {
  const { state } = useVoiceAssistant();
  return (
    <>
      <div
        className="flex items-center border-b px-3.5 py-2.5"
        style={{ borderColor: "var(--border-subtle)" }}
      >
        <span className="text-xs font-semibold" style={{ color: "var(--fg-primary)" }}>
          {STATE_LABEL[state]}
        </span>
        <button
          onClick={onEnd}
          className="ml-auto cursor-pointer text-2xs font-semibold transition-opacity hover:opacity-90"
          style={{ color: "var(--fg-secondary)" }}
        >
          End session
        </button>
      </div>
      <Waveform />
      <Transcript />
      <Pills pills={pills} />
    </>
  );
}
