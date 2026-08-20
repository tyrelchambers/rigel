/** Voice turns land in the EXISTING chat history so there is one auditable
 * record and no separate voice panel. One ChatHistoryEntry per voice session. */
import type { ChatHistoryEntry } from "@/panels/chat/chatHistory";

export interface VoiceSegment {
  id: string;
  text: string;
  fromAgent: boolean;
}

/**
 * One entry per TURN, not per transcription segment. Deepgram finalizes a
 * spoken sentence in several segments and the agent streams its answer a
 * phrase at a time, so mapping segments straight through turned "can you
 * update my canada hires deployment labels" into three separate chat
 * messages. Consecutive segments from the same speaker merge, keeping the
 * first id so a message already rendered is not remounted as its tail
 * arrives. Shared with the popover transcript (transcriptTurns) so the live
 * view and the saved session can never disagree about where a turn ends.
 */
export function mergeSegments(segments: VoiceSegment[]): VoiceSegment[] {
  const turns: VoiceSegment[] = [];
  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) continue;
    const last = turns[turns.length - 1];
    if (last && last.fromAgent === segment.fromAgent) {
      last.text = `${last.text} ${text}`;
      continue;
    }
    turns.push({ ...segment, text });
  }
  return turns;
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
    messages: mergeSegments(segments).map((s) => ({
      id: s.id,
      role: s.fromAgent ? ("assistant" as const) : ("user" as const),
      text: s.text,
    })),
  };
}
