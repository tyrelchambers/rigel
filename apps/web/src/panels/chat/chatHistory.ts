/**
 * Client-side persistence of past chat conversations (localStorage). Mirrors the
 * Swift ChatHistory: each conversation is one entry; a refresh restores the most
 * recent, and the history sheet lists/resumes/deletes the rest.
 */
import type { ChatMessage } from "./types";

const KEY = "rigel.chat.sessions";
const MAX_SESSIONS = 50;
const MAX_MESSAGES = 200;

export interface ChatHistoryEntry {
  /** Conversation id (stable across the conversation's lifetime). */
  id: string;
  /** Derived from the first user message. */
  title: string;
  createdAt: number;
  updatedAt: number;
  /** The CLI session id captured for this conversation, if any. */
  sessionId: string | null;
  messages: ChatMessage[];
}

/** A short title from the first user message (or a placeholder). */
export function deriveTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  const t = (first?.text ?? "").trim().replace(/\s+/g, " ");
  if (!t) return "New conversation";
  return t.length > 64 ? `${t.slice(0, 64)}…` : t;
}

/** All saved conversations, newest first. */
export function loadSessions(): ChatHistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return (arr as ChatHistoryEntry[])
      .filter(
        (e) =>
          e &&
          typeof e.id === "string" &&
          Array.isArray(e.messages) &&
          e.messages.length > 0,
      )
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  } catch {
    return [];
  }
}

/** The most recently updated conversation (restored on refresh), or null. */
export function loadMostRecent(): ChatHistoryEntry | null {
  return loadSessions()[0] ?? null;
}

/** Insert or update a conversation by id, keeping the newest MAX_SESSIONS. */
export function upsertSession(entry: ChatHistoryEntry): void {
  try {
    if (entry.messages.length === 0) return;
    const trimmed: ChatHistoryEntry = { ...entry, messages: entry.messages.slice(-MAX_MESSAGES) };
    const list = loadSessions().filter((e) => e.id !== entry.id);
    list.unshift(trimmed);
    const capped = list
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, MAX_SESSIONS);
    localStorage.setItem(KEY, JSON.stringify(capped));
  } catch {
    /* quota / unavailable — non-fatal */
  }
}

/** Remove one conversation by id. */
export function deleteSession(id: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(loadSessions().filter((e) => e.id !== id)));
  } catch {
    /* ignore */
  }
}

/** "just now" / "5m ago" / "3h ago" / "2d ago" from an epoch-ms timestamp. */
export function ageDescription(ms: number): string {
  const dt = (Date.now() - ms) / 1000;
  if (dt < 60) return "just now";
  if (dt < 3600) return `${Math.floor(dt / 60)}m ago`;
  if (dt < 86400) return `${Math.floor(dt / 3600)}h ago`;
  return `${Math.floor(dt / 86400)}d ago`;
}
