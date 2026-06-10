/**
 * Client-side persistence of the most recent chat conversation, so a page
 * refresh restores the visible transcript. Single-user-per-instance, so a single
 * localStorage slot is enough (no multi-session store).
 */
import type { ChatMessage } from "./types";

const KEY = "helmsman.chat.history";
/** Cap retained messages so the slot can't grow unbounded. */
const MAX_MESSAGES = 200;

export interface SavedChat {
  messages: ChatMessage[];
  sessionId: string | null;
  savedAt: number;
}

/** Load the saved conversation, or null when none/invalid/empty. */
export function loadChatHistory(): SavedChat | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<SavedChat>;
    if (!Array.isArray(p.messages) || p.messages.length === 0) return null;
    // Light shape check on the first message so a corrupt slot doesn't crash.
    const m0 = p.messages[0] as Partial<ChatMessage>;
    if (typeof m0.id !== "string" || typeof m0.role !== "string") return null;
    return {
      messages: p.messages as ChatMessage[],
      sessionId: typeof p.sessionId === "string" ? p.sessionId : null,
      savedAt: typeof p.savedAt === "number" ? p.savedAt : 0,
    };
  } catch {
    return null;
  }
}

/** Persist (or clear when empty) the conversation. */
export function saveChatHistory(messages: ChatMessage[], sessionId: string | null): void {
  try {
    if (messages.length === 0) {
      localStorage.removeItem(KEY);
      return;
    }
    const payload: SavedChat = {
      messages: messages.slice(-MAX_MESSAGES),
      sessionId,
      savedAt: Date.now(),
    };
    localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    /* quota exceeded / storage unavailable — non-fatal */
  }
}

/** Drop the saved conversation (used by "New chat"). */
export function clearChatHistory(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
