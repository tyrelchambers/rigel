/**
 * Popover contents, top to bottom: state line, live waveform, rolling
 * transcript, the mutations the worker has proposed, and the resources the
 * session has pinned. Must be rendered inside a RoomContext.Provider.
 */
import {
  useMultibandTrackVolume,
  useTranscriptions,
  useVoiceAssistant,
  type AgentState,
} from "@livekit/components-react";
import { MENTION_KIND_LABEL, type MentionCandidate } from "@/panels/chat/mentions";
import { useMicTrackRef } from "./useVoiceRoom";
import { AGENT_IDENTITY_PREFIX, type VoiceAction } from "./VoiceSessionEffects";

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

/** What a click-tier proposal targets, for the frames that carry no command. */
function actionTarget(action: VoiceAction["action"]): string {
  const name = action.name ?? action.deployment ?? action.pod ?? action.node;
  return [action.kind, name, action.namespace && `in ${action.namespace}`].filter(Boolean).join(" ");
}

function Actions({ actions, onRunClick }: { actions: VoiceAction[]; onRunClick: (a: VoiceAction) => void }) {
  if (actions.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 border-t px-3.5 py-2.5" style={{ borderColor: "var(--border-subtle)" }}>
      {actions.map((a) => (
        <div key={a.id} className="flex flex-col gap-1.5">
          {a.command ? (
            <code
              className="rounded px-2 py-1 font-mono text-3xs break-all"
              style={{ background: "var(--surface-sunken)", color: "var(--fg-secondary)" }}
            >
              {a.command}
            </code>
          ) : (
            <span className="text-2xs" style={{ color: "var(--fg-secondary)" }}>
              {actionTarget(a.action)}
            </span>
          )}
          {a.done ? (
            <span
              className="text-2xs font-semibold"
              style={{ color: a.done.ok ? "var(--status-running)" : "var(--status-failed)" }}
            >
              {a.done.ok ? "Ran" : a.done.summary || "Failed"}
            </span>
          ) : a.tier === "voice" ? (
            <span className="text-2xs" style={{ color: "var(--fg-tertiary)" }}>
              Say "confirm" to run, or "cancel".
            </span>
          ) : (
            <button
              onClick={() => onRunClick(a)}
              className="self-start cursor-pointer rounded border px-2.5 py-1 text-2xs font-semibold transition-opacity hover:opacity-90"
              style={{ borderColor: "var(--border-subtle)", color: "var(--fg-primary)", background: "var(--surface-sunken)" }}
            >
              {a.action.label ?? "Review and run"}
            </button>
          )}
          {a.unreported && (
            <span className="text-2xs" style={{ color: "var(--status-pending)" }}>
              {a.unreported}
            </span>
          )}
        </div>
      ))}
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

export function VoicePopoverBody({
  onEnd,
  pills,
  actions,
  onRunClick,
}: {
  onEnd: () => void;
  pills: MentionCandidate[];
  actions: VoiceAction[];
  onRunClick: (a: VoiceAction) => void;
}) {
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
      <Actions actions={actions} onRunClick={onRunClick} />
      <Pills pills={pills} />
    </>
  );
}
