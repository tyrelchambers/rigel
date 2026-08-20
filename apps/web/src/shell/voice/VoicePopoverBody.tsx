/**
 * Popover contents, top to bottom: the spectrum hairline, state line, live
 * waveform, rolling transcript, the resources the session has referenced, and
 * the mutations the worker has proposed. Must be rendered inside a
 * RoomContext.Provider.
 */
import { useEffect, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChevronDown } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { useMultibandTrackVolume, useTranscriptions, type AgentState } from "@livekit/components-react";
import { MessageScroller, useMessageScroller } from "@shadcn/react/message-scroller";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { isDestructiveAction } from "@/lib/actionBlocks";
import { MENTION_KIND_LABEL, type MentionCandidate } from "@/panels/chat/mentions";
import { useCluster } from "@/store/cluster";
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
import { mergeSegments, type VoiceSegment } from "./voiceHistory";

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
  const context = useCluster((s) => s.activeContext);
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
      {context && (
        <span
          className="truncate rounded-md border px-1.5 py-0.5 font-mono text-3xs"
          style={{
            background: "var(--surface-sunken)",
            borderColor: "var(--border-subtle)",
            color: "var(--fg-tertiary)",
          }}
        >
          {context}
        </span>
      )}
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

/** Reveals the transcript's bottom whenever a proposal arrives, overriding a
 *  reader's scroll-up: the operator has to see what is waiting for them
 *  regardless of where they are reading. */
function TranscriptFollow({ actions }: { actions: VoiceAction[] }) {
  const { scrollToEnd } = useMessageScroller();
  const reducedMotion = usePrefersReducedMotion();
  const openRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const open = new Set(actions.filter((a) => !a.done).map((a) => a.id));
    const isNew = [...open].some((id) => !openRef.current.has(id));
    openRef.current = open;
    if (isNew) scrollToEnd({ behavior: reducedMotion ? "auto" : "smooth" });
  }, [actions, reducedMotion, scrollToEnd]);
  return null;
}

/** The voice mark at conversation scale, so an answer is attributable at a
 *  glance rather than by bubble colour alone. */
function AgentMark() {
  return (
    <span className="relative mt-4 size-5 shrink-0">
      <span
        className="absolute inset-0 rounded-full border"
        style={{ borderColor: `${VOICE_SPECTRUM[0]}3d` }}
      />
      <span
        className="absolute inset-1 rounded-full border"
        style={{ borderColor: `${VOICE_SPECTRUM[0]}94` }}
      />
      <span
        className="absolute inset-[7px] rounded-full"
        style={{ background: "var(--accent-primary)" }}
      />
    </span>
  );
}

export type TranscriptTurn = VoiceSegment;

/**
 * One bubble per turn, not per transcription segment. LiveKit streams a
 * sentence, sometimes a phrase, as its own segment, so rendering them straight
 * left the log reading two or three words per line. The merge rule itself
 * lives with the history writer, so the live transcript and the saved session
 * split turns identically.
 */
export function transcriptTurns(
  items: { text: string; participantInfo?: { identity: string }; streamInfo?: { id: string } }[],
): TranscriptTurn[] {
  return mergeSegments(
    items.map((t, i) => ({
      id: t.streamInfo?.id ?? String(i),
      text: t.text,
      fromAgent: (t.participantInfo?.identity ?? "").startsWith(AGENT_IDENTITY_PREFIX),
    })),
  );
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
            <MessageScroller.Content className="flex flex-col gap-3.5">
              {recent.map(({ id, fromAgent, text }) =>
                fromAgent ? (
                  <MessageScroller.Item key={id} messageId={id} className="flex gap-2.5">
                    <AgentMark />
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="flex items-center gap-1.5">
                        <span className="text-3xs font-semibold" style={{ color: "var(--accent-soft)" }}>
                          Rigel
                        </span>
                      </span>
                      <span
                        className="max-w-[300px] rounded-[12px] rounded-tl-[4px] border px-[13px] py-2.5 text-xs leading-[18px]"
                        style={{
                          background: `${VOICE_SPECTRUM[0]}14`,
                          borderColor: `${VOICE_SPECTRUM[0]}3d`,
                          color: "var(--fg-primary)",
                        }}
                      >
                        {text}
                      </span>
                    </span>
                  </MessageScroller.Item>
                ) : (
                  <MessageScroller.Item key={id} messageId={id} className="flex flex-col">
                    <span
                      className="max-w-[90%] self-end rounded-[12px] rounded-br-[4px] border px-[13px] py-2.5 text-xs leading-[18px]"
                      style={{
                        background: "var(--surface-sunken)",
                        borderColor: "var(--border-subtle)",
                        color: "var(--fg-secondary)",
                      }}
                    >
                      {text}
                    </span>
                  </MessageScroller.Item>
                ),
              )}
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

/**
 * A change, command first. Two shapes: one the agent is running because the
 * operator asked for it, which shows what it is doing and offers no button,
 * and one waiting for approval, which the operator runs through the same
 * confirm sheet the chat panel uses. Nothing here is ever run by a spoken
 * word.
 */
function ProposalCard({
  action,
  onRunClick,
  onDismiss,
}: {
  action: VoiceAction;
  onRunClick: (a: VoiceAction) => void;
  onDismiss: (a: VoiceAction) => void;
}) {
  const destructive = isDestructiveAction(action.action);
  const accent = action.auto ? "var(--accent-primary)" : destructive ? "var(--status-failed)" : "var(--status-pending)";
  return (
    <div
      className="flex shrink-0 flex-col gap-2 border-t px-4 pt-3.5 pb-4"
      style={{ borderColor: "var(--border-subtle)" }}
    >
      <div
        className="flex flex-col overflow-hidden rounded-[10px] border"
        style={{
          background: `color-mix(in oklab, ${accent} 6%, transparent)`,
          borderColor: `color-mix(in oklab, ${accent} 30%, transparent)`,
        }}
      >
        <div className="flex flex-col gap-2.5 p-3">
          <code
            className="rounded-[7px] border px-2.5 py-2 font-mono text-2xs leading-[17px] break-all"
            style={{
              background: "var(--surface-sunken)",
              borderColor: "var(--border-subtle)",
              color: "var(--fg-primary)",
            }}
          >
            {action.command ?? actionTarget(action.action)}
          </code>
          <div className="flex items-center gap-2">
            {action.done ? (
              <span
                className="text-2xs font-semibold"
                style={{ color: action.done.ok ? "var(--status-running)" : "var(--status-failed)" }}
              >
                {action.done.ok ? "Ran" : action.done.summary || "Failed"}
              </span>
            ) : action.auto ? (
              <span className="text-2xs font-semibold" style={{ color: "var(--accent-primary)" }}>
                Running…
              </span>
            ) : (
              <>
                <button
                  onClick={() => onRunClick(action)}
                  className="cursor-pointer rounded-lg px-3 py-1.5 text-2xs font-semibold transition-opacity hover:opacity-90"
                  style={{ background: "var(--accent-primary)", color: "var(--fg-inverse)" }}
                >
                  {action.action.label ?? "Review and run"}
                </button>
                <button
                  onClick={() => onDismiss(action)}
                  className="cursor-pointer rounded-lg border px-3 py-1.5 text-2xs font-semibold transition-opacity hover:opacity-90"
                  style={{
                    background: "var(--surface-elevated)",
                    borderColor: "var(--border-strong)",
                    color: "var(--fg-secondary)",
                  }}
                >
                  Dismiss
                </button>
                <span className="ml-auto text-3xs" style={{ color: "var(--fg-tertiary)" }}>
                  {destructive ? "needs your approval" : "reversible"}
                </span>
              </>
            )}
          </div>
        </div>
      </div>
      {action.unreported && (
        <span className="text-2xs" style={{ color: "var(--status-pending)" }}>
          {action.unreported}
        </span>
      )}
    </div>
  );
}

function Pills({ pills }: { pills: MentionCandidate[] }) {
  const [open, setOpen] = useState(true);
  if (pills.length === 0) return null;
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="shrink-0 border-t"
      style={{ borderColor: "var(--border-subtle)" }}
    >
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 px-4 pt-2.5 pb-2 text-left">
        <span className="text-2xs font-semibold" style={{ color: "var(--fg-tertiary)" }}>
          Referenced this session
        </span>
        <span
          className="rounded-full px-1.5 py-px font-mono text-3xs font-semibold"
          style={{ background: "var(--surface-sunken)", color: "var(--fg-secondary)" }}
        >
          {pills.length}
        </span>
        <FontAwesomeIcon
          icon={faChevronDown}
          className={`ml-auto size-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          style={{ color: "var(--fg-tertiary)" }}
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex max-h-[7.5rem] flex-wrap items-center gap-1.5 overflow-y-auto px-4 pb-3.5">
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
      </CollapsibleContent>
    </Collapsible>
  );
}

export function VoicePopoverBody({
  onEnd,
  report,
  pills,
  actions,
  onRunClick,
  onCancel,
}: {
  onEnd: () => void;
  report: AgentReport;
  pills: MentionCandidate[];
  actions: VoiceAction[];
  onRunClick: (a: VoiceAction) => void;
  onCancel: (a: VoiceAction) => void;
}) {
  return (
    <>
      <SignalEdge />
      <StateRow onEnd={onEnd} report={report} />
      <Waveform report={report} />
      <Transcript actions={actions} />
      <Pills pills={pills} />
      {actions.map((a) => (
        <ProposalCard key={a.id} action={a} onRunClick={onRunClick} onDismiss={onCancel} />
      ))}
    </>
  );
}
