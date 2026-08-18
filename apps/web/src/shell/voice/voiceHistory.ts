/** Voice turns land in the EXISTING chat history so there is one auditable
 * record and no separate voice panel. One ChatHistoryEntry per voice session. */
import type { ChatHistoryEntry } from "@/panels/chat/chatHistory";

export interface VoiceSegment {
  id: string;
  text: string;
  fromAgent: boolean;
}

export function toHistoryEntry(
  sessionId: string,
  createdAt: number,
  segments: VoiceSegment[],
  updatedAt: number,
): ChatHistoryEntry {
  return {
    id: sessionId,
    title: "Voice session",
    createdAt,
    updatedAt,
    sessionId: null,
    messages: segments.map((s) => ({
      id: s.id,
      role: s.fromAgent ? ("assistant" as const) : ("user" as const),
      text: s.text,
    })),
  };
}
