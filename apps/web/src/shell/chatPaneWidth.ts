/**
 * ChatPane width persistence — pure helpers for loading/saving the resizable
 * chat-pane width to localStorage, clamped to the allowed range.
 *
 * Width: resizable via drag on the left edge (280–520px), persisted to
 * localStorage under key "helmsman.chatPane.width".
 */

// ── Resize persistence ────────────────────────────────────────────────────────

export const PANE_WIDTH_KEY = "helmsman.chatPane.width";
export const MIN_WIDTH = 280;
export const MAX_WIDTH = 520;
export const DEFAULT_WIDTH = 360;

export function loadPaneWidth(): number {
  try {
    const raw = localStorage.getItem(PANE_WIDTH_KEY);
    if (raw === null) return DEFAULT_WIDTH;
    const n = parseInt(raw, 10);
    if (isNaN(n)) return DEFAULT_WIDTH;
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
  } catch {
    return DEFAULT_WIDTH;
  }
}

export function savePaneWidth(w: number): void {
  try {
    localStorage.setItem(PANE_WIDTH_KEY, String(w));
  } catch {
    // ignore
  }
}
