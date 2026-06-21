/**
 * Cluster-scope selection for the chat composer: tells the Helmsman which
 * kubeconfig contexts it may READ from this turn (active only, all, or a pick).
 * Mirrors composerModel.ts (type + label + localStorage persistence). The server
 * resolves the wire shape to a concrete read-context list; see chatScope.ts.
 */
export type ScopeMode = "active" | "all" | "pick";

export interface ScopeSelection {
  mode: ScopeMode;
  /** Selected context names — only meaningful when mode === "pick". */
  picked: string[];
}

export const DEFAULT_SCOPE: ScopeSelection = { mode: "active", picked: [] };

/** The wire shape sent on the chat frame and parsed by the server. */
export type ChatScopeWire = "active" | "all" | { contexts: string[] };

export function scopeToWire(s: ScopeSelection): ChatScopeWire {
  if (s.mode === "all") return "all";
  if (s.mode === "pick" && s.picked.length > 0) return { contexts: s.picked };
  return "active";
}

/** Compact label for the composer pill. */
export function scopeLabel(s: ScopeSelection): string {
  if (s.mode === "active") return "Active cluster";
  if (s.mode === "all") return "All clusters";
  if (s.picked.length === 0) return "Pick clusters";
  return `${s.picked.length} cluster${s.picked.length === 1 ? "" : "s"}`;
}

const STORAGE_KEY = "rigel.chat.scope";

export function loadScope(): ScopeSelection {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<ScopeSelection>;
      if (p.mode === "active" || p.mode === "all" || p.mode === "pick") {
        return {
          mode: p.mode,
          picked: Array.isArray(p.picked) ? p.picked.filter((x): x is string => typeof x === "string") : [],
        };
      }
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_SCOPE;
}

export function saveScope(s: ScopeSelection): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
