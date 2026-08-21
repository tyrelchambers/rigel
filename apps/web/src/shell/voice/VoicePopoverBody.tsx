/**
 * Popover contents, top to bottom: the spectrum hairline, state line, live
 * waveform, rolling transcript, the resources the session has referenced, and
 * the mutations the worker has proposed. Must be rendered inside a
 * RoomContext.Provider.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { useMultibandTrackVolume, useTranscriptions, type AgentState } from "@livekit/components-react";
import { MessageScroller, useMessageScroller } from "@shadcn/react/message-scroller";
import { CommandBlock } from "@/components/CommandBlock";
import { isDestructiveAction } from "@/lib/actionBlocks";
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
import { mergeSegments, type VoiceSegment } from "./voiceTurns";

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

/** The workload a repo fix targets, the way the operator says it out loud. */
function workloadLine(action: VoiceAction["action"]): string {
  return [action.name, action.namespace && `in ${action.namespace}`].filter(Boolean).join(" ");
}

/**
 * A typed manifest edit in the words the operator used, not the JSON the model
 * sent. Falls through to the kind's own label when the edit is a shape this
 * does not model, which keeps an unknown op visible rather than blank.
 */
function editLine(action: VoiceAction["action"]): string {
  const edit = action.edit;
  if (!edit || typeof edit !== "object") return action.label ?? "";
  const pairs = (map: Record<string, string | null> | undefined) =>
    Object.entries(map ?? {})
      .map(([k, v]) => (v === null ? `remove ${k}` : `set ${k} to ${v}`))
      .join(", ");
  switch (edit.op) {
    case "annotate":
      return pairs(edit.annotations);
    case "label":
      return pairs(edit.labels);
    case "setImage":
      return `use image ${edit.image}${edit.container ? ` on ${edit.container}` : ""}`;
    case "scale":
      return `scale to ${edit.replicas} replicas`;
    default:
      return action.label ?? "";
  }
}

/** One `key   value` row inside a card's detail block. */
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-[62px] shrink-0 text-2xs" style={{ color: "var(--fg-tertiary)" }}>
        {label}
      </span>
      <span className="min-w-0 flex-1 font-mono text-2xs break-words" style={{ color: "var(--fg-primary)" }}>
        {value}
      </span>
    </div>
  );
}

/** The dark inset every card puts its content in. */
function CardBlock({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex flex-col gap-1.5 rounded-lg border px-[11px] py-2.5"
      style={{ background: "#00000059", borderColor: "var(--border-subtle)" }}
    >
      {children}
    </div>
  );
}

/** kind · state, with the blast radius or outcome noted on the right. */
function CardHead({ kind, state, stateColor, note }: { kind: string; state: string; stateColor: string; note?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="font-mono text-3xs font-semibold tracking-wider" style={{ color: "var(--fg-tertiary)" }}>
        {kind}
      </span>
      <span className="text-3xs" style={{ color: "var(--fg-tertiary)" }}>
        ·
      </span>
      <span className="font-mono text-3xs font-semibold tracking-wider" style={{ color: stateColor }}>
        {state}
      </span>
      {note && (
        <span className="ml-auto font-mono text-3xs tracking-wider" style={{ color: "var(--fg-tertiary)" }}>
          {note}
        </span>
      )}
    </div>
  );
}

/** A dot and a sentence: what the agent did, or is doing, with no button. */
function CardStatus({ color, text, trailing }: { color: string; text: string; trailing?: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: color }} />
      <span className="text-2xs font-semibold" style={{ color }}>
        {text}
      </span>
      {trailing && <span className="ml-auto">{trailing}</span>}
    </div>
  );
}

/**
 * A change, in whichever state it has reached. The head reads the same in every
 * one of them, so the eye lands in the same place whether the card is asking
 * for a tap or reporting what it did, and colour carries the state without ever
 * being the only signal.
 *
 * Three shapes of content. A kubectl change shows its command, because the card
 * is the receipt. A pull request has no command to show, so it names the repo,
 * the workload and the change instead, and once it is open the number leads,
 * since that is what the operator repeats to a colleague. A failure shows the
 * reason in full, because that is usually the thing that says what to fix.
 *
 * Nothing here is ever run by a spoken word.
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
  const { done } = action;
  const isRepoFix = action.action.kind === "proposeRepoFix";
  const destructive = isDestructiveAction(action.action);

  const accent = done
    ? done.ok
      ? "var(--status-running)"
      : "var(--status-failed)"
    : action.auto
      ? "var(--accent-primary)"
      : destructive
        ? "var(--status-failed)"
        : "var(--status-pending)";

  const state = done ? (done.ok ? (isRepoFix ? "open" : "done") : "failed") : action.auto ? (isRepoFix ? "opening" : "running") : "needs approval";
  const note = done
    ? isRepoFix
      ? done.ok
        ? "awaiting review"
        : "nothing pushed"
      : undefined
    : isRepoFix
      ? "no cluster change"
      : action.auto
        ? undefined
        : destructive
          ? "irreversible"
          : "reversible";

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
          <CardHead kind={action.action.kind} state={state} stateColor={accent} note={note} />

          {done && !done.ok ? (
            <CardBlock>
              <span className="text-2xs leading-[17px]" style={{ color: "var(--fg-primary)" }}>
                {done.summary || "It failed."}
              </span>
            </CardBlock>
          ) : isRepoFix && done?.ok ? (
            <CardBlock>
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-bold" style={{ color: "var(--fg-primary)" }}>
                  {`#${done.summary.match(/#(\d+)/)?.[1] ?? "?"}`}
                </span>
                <span className="min-w-0 flex-1 text-2xs leading-[16px]" style={{ color: "var(--fg-secondary)" }}>
                  {action.action.title ?? action.action.label}
                </span>
              </div>
              {done.repoSlug && <DetailRow label="repository" value={done.repoSlug} />}
            </CardBlock>
          ) : isRepoFix ? (
            <CardBlock>
              {action.action.source && <DetailRow label="source" value={action.action.source} />}
              <DetailRow label="workload" value={workloadLine(action.action)} />
              <DetailRow label="change" value={editLine(action.action)} />
            </CardBlock>
          ) : action.command ? (
            <CommandBlock
              command={action.command}
              accent={destructive ? "var(--status-failed)" : "var(--accent-primary)"}
              compact
            />
          ) : (
            // purge and applyManifest carry no command: the ConfirmSheet builds
            // their preview. Naming the target is all this card can honestly show.
            <span className="text-2xs" style={{ color: "var(--fg-secondary)" }}>
              {actionTarget(action.action)}
            </span>
          )}

          {done ? (
            done.ok ? (
              <CardStatus
                color={accent}
                text={isRepoFix ? "Nothing changed on the cluster" : done.summary || "Done"}
                trailing={
                  done.prUrl ? (
                    <a
                      href={done.prUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-2xs font-semibold"
                      style={{ color: "var(--accent-primary)" }}
                    >
                      View pull request
                    </a>
                  ) : undefined
                }
              />
            ) : (
              <CardStatus color={accent} text={isRepoFix ? "No branch was left behind" : "Nothing changed"} />
            )
          ) : action.auto ? (
            <CardStatus color={accent} text={isRepoFix ? "Opening a pull request" : "Running"} />
          ) : (
            <div className="flex items-center gap-2">
              <button
                onClick={() => onRunClick(action)}
                // The label is the model's, so its length is not ours to
                // assume: "Delete pod canada-hires-web-6f8c94" alone is wider
                // than the card. It truncates rather than pushing Dismiss out
                // of a card that clips its overflow.
                className="min-w-0 shrink cursor-pointer truncate rounded-lg px-3 py-1.5 text-2xs font-semibold transition-opacity hover:opacity-90"
                style={{
                  // Same rule as the ConfirmSheet this button opens: red for
                  // destructive, the brand accent for everything else. An
                  // outage that destroys nothing keeps the neutral button and
                  // says irreversible in the head instead.
                  background: destructive ? "var(--status-failed)" : "var(--accent-primary)",
                  color: destructive ? "var(--fg-primary)" : "var(--fg-inverse)",
                }}
                title={action.action.label ?? "Review and run"}
              >
                {action.action.label ?? "Review and run"}
              </button>
              <button
                onClick={() => onDismiss(action)}
                className="shrink-0 cursor-pointer rounded-lg border px-3 py-1.5 text-2xs font-semibold transition-opacity hover:opacity-90"
                style={{
                  background: "var(--surface-elevated)",
                  borderColor: "var(--border-strong)",
                  color: "var(--fg-secondary)",
                }}
              >
                Dismiss
              </button>
            </div>
          )}
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

export function VoicePopoverBody({
  onEnd,
  report,
  actions,
  onRunClick,
  onCancel,
}: {
  onEnd: () => void;
  report: AgentReport;
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
      {actions.map((a) => (
        <ProposalCard key={a.id} action={a} onRunClick={onRunClick} onDismiss={onCancel} />
      ))}
    </>
  );
}
