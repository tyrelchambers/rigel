// Chat domain types — mirrors the Swift ChatMessage model and the WebSocket
// chat contract (docs/parity/chat.md § WebSocket Transport Contract).

export type ChatRole = "user" | "assistant" | "system";

/** A tool call and its result, carried on a system ChatMessage. */
export interface ToolActivity {
  id: string;
  name: string;
  /** Extracted Bash command, if applicable. */
  command?: string;
  /** Extracted Bash description, if applicable. */
  description?: string;
  /** Raw tool input JSON, for an expandable view. */
  inputJSON: string;
  status: "running" | "ok" | "error";
  /** Result/stderr/denial text, populated when status is ok or error. */
  output?: string;
}

/** A single chat message. `id` is a UUID used for scroll anchoring. */
export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  /** Stamped from thinking deltas at turn end; empty/undefined → no trail. */
  thinking?: string;
  /** Seconds from turnStartedAt to turn end; undefined → not shown. */
  thinkingSeconds?: number;
  /** Tool-activity card carried on system messages. */
  tool?: ToolActivity;
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
  | { type: "sessionEnded"; text?: string }
  /** Tool call initiated by the assistant. */
  | { type: "tool"; toolId: string; toolName: string; command?: string; description?: string; inputJSON: string }
  /** Result of a tool call. */
  | { type: "toolResult"; toolId: string; isError: boolean; output?: string };
