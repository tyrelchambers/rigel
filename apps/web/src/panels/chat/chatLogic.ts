// Pure chat helpers — kept out of the React component so they can be unit
// tested in isolation. Mirrors the Swift ChatPanel view-model logic.
import type { ActionBlock } from "@/lib/api";
import type { SuggestedAction } from "@/lib/actionBlocks";
import type { ChatMessage, ChatRole } from "./types";

/** Slack (px) below which the viewport counts as "at bottom". */
export const AT_BOTTOM_THRESHOLD = 24;
/** Minimum gap between throttled streaming tail-scrolls (ms). */
export const TAIL_SCROLL_THROTTLE_MS = 100;

/**
 * Near-bottom detection: content bottom minus the visible bottom is within the
 * threshold. scrollTop + clientHeight reaches scrollHeight at the very bottom.
 */
export function isNearBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  threshold = AT_BOTTOM_THRESHOLD,
): boolean {
  return scrollHeight - (scrollTop + clientHeight) < threshold;
}

/** Jump-to-newest button shows only when scrolled up AND there are messages. */
export function showJumpToNewest(isAtBottom: boolean, messageCount: number): boolean {
  return !isAtBottom && messageCount > 0;
}

/** UUID for a new message (crypto.randomUUID, with a fallback-free path). */
export function newId(): string {
  return crypto.randomUUID();
}

/** Build a plain ChatMessage. */
export function makeMessage(role: ChatRole, text: string): ChatMessage {
  return { id: newId(), role, text };
}

/** Elapsed whole seconds from a start instant to now (or a given end). */
export function elapsedSeconds(start: Date, end: Date = new Date()): number {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
}

/**
 * Apply a text delta: append to the last assistant message, or start a new
 * assistant message if the last message is not an in-progress assistant turn.
 * Returns a new array (immutable update).
 */
export function appendTextDelta(messages: ChatMessage[], delta: string): ChatMessage[] {
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant") {
    // Each "text" event is a COMPLETE text block from the bridge (no partial
    // token streaming), so separate consecutive blocks with a blank line —
    // otherwise the segments Claude emits around tool calls run together
    // ("…investigate.A pnpm monorepo.").
    const sep = last.text && delta ? "\n\n" : "";
    const updated = { ...last, text: last.text + sep + delta };
    return [...messages.slice(0, -1), updated];
  }
  return [...messages, { id: newId(), role: "assistant", text: delta }];
}

/**
 * Stamp accumulated thinking onto the last assistant message at turn end.
 * No-op if there is no thinking text or no assistant message to stamp.
 */
export function stampThinking(
  messages: ChatMessage[],
  thinking: string,
  thinkingSeconds: number,
): ChatMessage[] {
  if (!thinking.trim()) return messages;
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return messages;
  const updated = { ...last, thinking, thinkingSeconds };
  return [...messages.slice(0, -1), updated];
}

/** Rotating thinking verbs, cycled on a 2.5s interval. */
export const THINKING_VERBS = [
  "Thinking",
  "Investigating",
  "Reasoning",
  "Inspecting",
  "Working",
] as const;

export function thinkingVerb(cycleIndex: number): string {
  return THINKING_VERBS[cycleIndex % THINKING_VERBS.length];
}

const ROLE_LABEL: Record<ChatRole, string> = {
  user: "You",
  assistant: "Rigel",
  system: "System",
};

/**
 * transcript() — role-labeled conversation for "Copy conversation". Action
 * blocks are hidden (we copy the displayed text). System messages included.
 */
export function transcript(
  messages: ChatMessage[],
  strip: (text: string) => string,
): string {
  return messages
    .map((m) => `${ROLE_LABEL[m.role]}: ${m.role === "assistant" ? strip(m.text) : m.text}`)
    .join("\n\n");
}

/** First 8 chars of a session id, for the header tag. */
export function shortSessionId(sessionId: string | null): string | null {
  return sessionId ? sessionId.slice(0, 8) : null;
}

/**
 * Convert a parsed SuggestedAction into the ActionBlock shape the ConfirmSheet
 * / /api/action route consumes. They share fields; this is a structural pass
 * with the `target = name ?? deployment` back-compat handled server-side.
 */
export function toActionBlock(action: SuggestedAction): ActionBlock {
  return action;
}

/** Append a system message carrying a running tool-activity card. */
export function appendToolActivity(
  messages: ChatMessage[],
  ev: { toolId: string; toolName: string; command?: string; description?: string; inputJSON: string },
): ChatMessage[] {
  return [
    ...messages,
    {
      id: newId(),
      role: "system",
      text: "",
      tool: {
        id: ev.toolId,
        name: ev.toolName,
        command: ev.command,
        description: ev.description,
        inputJSON: ev.inputJSON,
        status: "running",
      },
    },
  ];
}

/** Update the matching tool-activity card with its result (by tool id). */
export function applyToolResult(
  messages: ChatMessage[],
  toolId: string,
  isError: boolean,
  output?: string,
): ChatMessage[] {
  return messages.map((m) =>
    m.tool && m.tool.id === toolId
      ? { ...m, tool: { ...m.tool, status: isError ? "error" : "ok", output } }
      : m,
  );
}
