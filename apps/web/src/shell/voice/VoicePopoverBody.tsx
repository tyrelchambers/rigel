/**
 * Popover contents, top to bottom: the spectrum hairline, state line, live
 * waveform, rolling transcript, the resources the session has referenced, and
 * the mutations the worker has proposed. Must be rendered inside a
 * RoomContext.Provider.
 */
import { useEffect, useRef, useState } from "react";
import { differenceInSeconds } from "date-fns";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCircleExclamation } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { useMultibandTrackVolume, useTranscriptions, type AgentState } from "@livekit/components-react";
import { MessageScroller, useMessageScroller } from "@shadcn/react/message-scroller";
import { MENTION_KIND_LABEL, type MentionCandidate } from "@/panels/chat/mentions";
import { useAssistantState, useMicTrackRef } from "./useVoiceRoom";
import {
  markAppearance,
  spectrumAt,
  usePrefersReducedMotion,
  visualStateFor,
  voiceHalo,
  VOICE_LEVEL_GAIN,
  VOICE_SPECTRUM,
  type AgentReport,
} from "./VoiceMark";
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

/** Must stay in step with PENDING_TTL_MS in apps/voice/src/mutationFlow.ts. */
const CONFIRM_TTL_MS = 45_000;

const DOT_HALO_ALPHA = "66";

const BAR_COUNT = 28;
const BAR_MIN_PX = 6;
const BAR_MAX_PX = 60;

function SignalEdge() {
  return (
    <div
      aria-hidden
      className="h-[2px] w-full shrink-0"
      style={{
        backgroundImage: `linear-gradient(-90deg, ${VOICE_SPECTRUM[0]} 0%, ${VOICE_SPECTRUM[1]} 55%, ${VOICE_SPECTRUM[2]} 100%)`,
      }}
    />
  );
}

function Waveform({ report }: { report: AgentReport }) {
  const { state, audioTrack } = useAssistantState(report);
  const micRef = useMicTrackRef();
  const bands = useMultibandTrackVolume(state === "speaking" ? audioTrack : micRef, { bands: BAR_COUNT });
  // With no track the hook hands back an empty array, which would leave the
  // band blank rather than resting.
  const levels = bands.length > 0 ? bands : (new Array<number>(BAR_COUNT).fill(0) as number[]);
  return (
    <div
      aria-hidden
      data-voice-waveform
      className="flex h-[76px] shrink-0 items-center justify-center gap-[3px] border-y px-4"
      style={{ background: "var(--surface-sunken)", borderColor: "var(--border-subtle)" }}
    >
      {levels.map((v, i) => {
        const amp = Number.isFinite(v) ? Math.min(1, Math.max(0, v * VOICE_LEVEL_GAIN)) : 0;
        return (
          <div
            key={i}
            className="w-[6px] shrink-0 rounded-[3px]"
            style={{
              height: BAR_MIN_PX + amp * (BAR_MAX_PX - BAR_MIN_PX),
              background: spectrumAt(i / Math.max(1, levels.length - 1)),
              opacity: 0.6 + amp * 0.4,
            }}
          />
        );
      })}
    </div>
  );
}

function StateRow({ onEnd, report }: { onEnd: () => void; report: AgentReport }) {
  const { state } = useAssistantState(report);
  const reducedMotion = usePrefersReducedMotion();
  const { color, glow } = markAppearance(visualStateFor(state, true), 0, reducedMotion);
  return (
    <div className="flex shrink-0 items-center gap-2 px-4 pt-3.5 pb-2.5">
      <span className="relative size-2 shrink-0">
        {glow && (
          <span
            className="pointer-events-none absolute -inset-1 rounded-full"
            style={{ backgroundImage: voiceHalo(color, DOT_HALO_ALPHA) }}
          />
        )}
        <span className="absolute inset-0 rounded-full" style={{ background: color }} />
      </span>
      <span className="text-xs font-semibold" style={{ color: "var(--fg-primary)" }}>
        {STATE_LABEL[state]}
      </span>
      <button
        onClick={onEnd}
        className="ml-auto cursor-pointer rounded-lg border px-2.5 py-1 text-2xs font-medium transition-opacity hover:opacity-90"
        style={{
          background: "var(--surface-sunken)",
          borderColor: "var(--border-subtle)",
          color: "var(--fg-secondary)",
        }}
      >
        End session
      </button>
    </div>
  );
}

/** Reveals the transcript's bottom whenever a voice-tier action arms,
 *  overriding a reader's scroll-up: a spoken "confirm" is about to run a
 *  cluster mutation, so it must surface regardless of where they're reading. */
function TranscriptFollow({ actions }: { actions: VoiceAction[] }) {
  const { scrollToEnd } = useMessageScroller();
  const reducedMotion = usePrefersReducedMotion();
  const armedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const armed = new Set(actions.filter((a) => a.tier === "voice" && !a.done).map((a) => a.id));
    const isNew = [...armed].some((id) => !armedRef.current.has(id));
    armedRef.current = armed;
    if (isNew) scrollToEnd({ behavior: reducedMotion ? "auto" : "smooth" });
  }, [actions, reducedMotion, scrollToEnd]);
  return null;
}

export interface TranscriptTurn {
  id: string;
  fromAgent: boolean;
  text: string;
}

/**
 * One bubble per turn, not per transcription segment. LiveKit streams a
 * sentence, sometimes a phrase, as its own segment, so rendering them straight
 * left the log reading two or three words per line.
 */
export function transcriptTurns(
  items: { text: string; participantInfo?: { identity: string }; streamInfo?: { id: string } }[],
): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  items.forEach((t, i) => {
    const text = t.text.trim();
    if (!text) return;
    const fromAgent = (t.participantInfo?.identity ?? "").startsWith(AGENT_IDENTITY_PREFIX);
    const last = turns[turns.length - 1];
    if (last && last.fromAgent === fromAgent) {
      last.text = `${last.text} ${text}`;
      return;
    }
    turns.push({ id: t.streamInfo?.id ?? String(i), fromAgent, text });
  });
  return turns;
}

function Transcript({ actions }: { actions: VoiceAction[] }) {
  const recent = transcriptTurns(useTranscriptions()).slice(-12);
  return (
    <MessageScroller.Provider autoScroll defaultScrollPosition="end">
      <TranscriptFollow actions={actions} />
      <MessageScroller.Root>
        <MessageScroller.Viewport className="max-h-[min(46vh,26rem)] overflow-y-auto px-4 py-3.5">
          {recent.length === 0 ? (
            <span className="text-2xs" style={{ color: "var(--fg-tertiary)" }}>
              Say something. Your words appear here as you speak.
            </span>
          ) : (
            <MessageScroller.Content className="flex flex-col gap-2.5">
              {recent.map(({ id, fromAgent, text }) => {
                return (
                  <MessageScroller.Item key={id} messageId={id} className="flex flex-col">
                    <span
                      className={`rounded-[9px] border px-[11px] py-2 text-xs leading-[18px] ${fromAgent ? "max-w-[260px] self-start" : "max-w-[90%] self-end"}`}
                      style={
                        fromAgent
                          ? {
                              background: `${VOICE_SPECTRUM[0]}14`,
                              borderColor: `${VOICE_SPECTRUM[0]}3d`,
                              color: "var(--fg-primary)",
                            }
                          : {
                              background: "var(--surface-sunken)",
                              borderColor: "var(--border-subtle)",
                              color: "var(--fg-secondary)",
                            }
                      }
                    >
                      {text}
                    </span>
                  </MessageScroller.Item>
                );
              })}
            </MessageScroller.Content>
          )}
        </MessageScroller.Viewport>
      </MessageScroller.Root>
    </MessageScroller.Provider>
  );
}

/** What a click-tier proposal targets, for the frames that carry no command. */
function actionTarget(action: VoiceAction["action"]): string {
  const name = action.name ?? action.deployment ?? action.pod ?? action.node;
  return [action.kind, name, action.namespace && `in ${action.namespace}`].filter(Boolean).join(" ");
}

/** Seconds left before the worker drops the arming, or null if it never stamped.
 *  Rounded up so the first tick reads the full window rather than one short. */
export function confirmSecondsLeft(receivedAt: number | undefined, now: number): number | null {
  if (receivedAt == null) return null;
  return Math.max(0, differenceInSeconds(receivedAt + CONFIRM_TTL_MS, now, { roundingMethod: "ceil" }));
}

function PendingConfirm({ action, now }: { action: VoiceAction; now: number }) {
  const left = confirmSecondsLeft(action.receivedAt, now);
  return (
    <div
      className="flex shrink-0 flex-col gap-2 border-t px-4 pt-3 pb-3.5"
      style={{
        background: "color-mix(in oklab, var(--status-pending) 6%, transparent)",
        borderColor: "var(--status-pending)",
      }}
    >
      <div className="flex items-center gap-[7px]">
        <FontAwesomeIcon
          icon={faCircleExclamation}
          className="size-[13px] shrink-0"
          style={{ color: "var(--status-pending)" }}
        />
        <span className="text-2xs font-semibold" style={{ color: "var(--status-pending)" }}>
          Say "confirm" to run
        </span>
        {left != null && (
          <span className="ml-auto font-mono text-2xs" style={{ color: "var(--fg-tertiary)" }}>
            {`${left}s`}
          </span>
        )}
      </div>
      <code
        className="rounded-[7px] border px-2.5 py-2 font-mono text-2xs leading-[17px] break-all"
        style={{
          background: "var(--surface-sunken)",
          borderColor: "var(--border-subtle)",
          color: "var(--fg-secondary)",
        }}
      >
        {action.command ?? actionTarget(action.action)}
      </code>
      {action.unreported && (
        <span className="text-2xs" style={{ color: "var(--status-pending)" }}>
          {action.unreported}
        </span>
      )}
    </div>
  );
}

function ActionRow({ action, onRunClick }: { action: VoiceAction; onRunClick: (a: VoiceAction) => void }) {
  return (
    <div
      className="flex shrink-0 flex-col gap-1.5 border-t px-4 py-2.5"
      style={{ borderColor: "var(--border-subtle)" }}
    >
      {action.command ? (
        <code
          className="rounded-[7px] px-2 py-1 font-mono text-3xs break-all"
          style={{ background: "var(--surface-sunken)", color: "var(--fg-secondary)" }}
        >
          {action.command}
        </code>
      ) : (
        <span className="text-2xs" style={{ color: "var(--fg-secondary)" }}>
          {actionTarget(action.action)}
        </span>
      )}
      {action.done ? (
        <span
          className="text-2xs font-semibold"
          style={{ color: action.done.ok ? "var(--status-running)" : "var(--status-failed)" }}
        >
          {action.done.ok ? "Ran" : action.done.summary || "Failed"}
        </span>
      ) : (
        <button
          onClick={() => onRunClick(action)}
          className="cursor-pointer self-start rounded-lg border px-2.5 py-1 text-2xs font-semibold transition-opacity hover:opacity-90"
          style={{
            borderColor: "var(--border-subtle)",
            color: "var(--fg-primary)",
            background: "var(--surface-sunken)",
          }}
        >
          {action.action.label ?? "Review and run"}
        </button>
      )}
      {action.unreported && (
        <span className="text-2xs" style={{ color: "var(--status-pending)" }}>
          {action.unreported}
        </span>
      )}
    </div>
  );
}

function Pills({ pills }: { pills: MentionCandidate[] }) {
  if (pills.length === 0) return null;
  return (
    <div
      className="flex max-h-[7.5rem] shrink-0 flex-wrap items-center gap-1.5 overflow-y-auto border-t px-4 pt-2.5 pb-3.5"
      style={{ borderColor: "var(--border-subtle)" }}
    >
      {pills.map((p) => (
        <span
          key={p.id}
          className="inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-2xs"
          style={{
            background: "var(--surface-sunken)",
            borderColor: "var(--border-subtle)",
            color: "var(--fg-secondary)",
          }}
        >
          <span className="font-mono text-3xs font-semibold" style={{ color: "var(--accent-primary)" }}>
            {MENTION_KIND_LABEL[p.kind]}
          </span>
          {p.name}
        </span>
      ))}
    </div>
  );
}

export function VoicePopoverBody({
  onEnd,
  report,
  pills,
  actions,
  onRunClick,
}: {
  onEnd: () => void;
  report: AgentReport;
  pills: MentionCandidate[];
  actions: VoiceAction[];
  onRunClick: (a: VoiceAction) => void;
}) {
  const counting = actions.some((a) => a.tier === "voice" && !a.done);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!counting) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [counting]);
  return (
    <>
      <SignalEdge />
      <StateRow onEnd={onEnd} report={report} />
      <Waveform report={report} />
      <Transcript actions={actions} />
      <Pills pills={pills} />
      {actions.map((a) =>
        a.tier === "voice" && !a.done ? (
          <PendingConfirm key={a.id} action={a} now={now} />
        ) : (
          <ActionRow key={a.id} action={a} onRunClick={onRunClick} />
        ),
      )}
    </>
  );
}
