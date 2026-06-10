// Chat domain types — mirrors the Swift ChatMessage model and the WebSocket
// chat contract (docs/parity/chat.md § WebSocket Transport Contract).

export type ChatRole = "user" | "assistant" | "system";

/** A single chat message. `id` is a UUID used for scroll anchoring. */
export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  /** Stamped from thinking deltas at turn end; empty/undefined → no trail. */
  thinking?: string;
  /** Seconds from turnStartedAt to turn end; undefined → not shown. */
  thinkingSeconds?: number;
}

/**
 * Server → client streaming events. Thinking and text interleave; all `text`
 * fields are deltas the client accumulates. `done` ends a turn, `error` is
 * terminal.
 */
export type ChatEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "done" }
  | { type: "error"; text: string }
  /** Server may surface init/session metadata. */
  | { type: "session"; sessionId: string }
  /** Usage-limit and stale-session signals (edge cases). */
  | { type: "usageLimit"; text?: string }
  | { type: "sessionEnded"; text?: string };
