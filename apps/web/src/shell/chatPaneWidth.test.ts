/**
 * Tests for ChatPane width persistence helpers.
 * Mirrors the logic in ChatPane.tsx: load/save to localStorage, clamping to 280–520.
 */
import { describe, it, expect, beforeEach } from "vitest";

const PANE_WIDTH_KEY = "helmsman.chatPane.width";
const MIN_WIDTH = 280;
const MAX_WIDTH = 520;
const DEFAULT_WIDTH = 360;

// Pure helpers extracted from ChatPane.tsx for testing.
function loadPaneWidth(storage: Storage): number {
  const raw = storage.getItem(PANE_WIDTH_KEY);
  if (raw === null) return DEFAULT_WIDTH;
  const n = parseInt(raw, 10);
  if (isNaN(n)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
}

function savePaneWidth(storage: Storage, w: number): void {
  storage.setItem(PANE_WIDTH_KEY, String(w));
}

function makeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as Storage;
}

describe("ChatPane width persistence", () => {
  let storage: Storage;
  beforeEach(() => {
    storage = makeStorage();
  });

  it("returns default (360) when storage is empty", () => {
    expect(loadPaneWidth(storage)).toBe(DEFAULT_WIDTH);
  });

  it("round-trips a valid width", () => {
    savePaneWidth(storage, 400);
    expect(loadPaneWidth(storage)).toBe(400);
  });

  it("clamps below minimum to 280", () => {
    savePaneWidth(storage, 100);
    expect(loadPaneWidth(storage)).toBe(MIN_WIDTH);
  });

  it("clamps above maximum to 520", () => {
    savePaneWidth(storage, 9999);
    expect(loadPaneWidth(storage)).toBe(MAX_WIDTH);
  });

  it("returns default for non-numeric stored value", () => {
    storage.setItem(PANE_WIDTH_KEY, "not-a-number");
    expect(loadPaneWidth(storage)).toBe(DEFAULT_WIDTH);
  });

  it("accepts the exact min boundary", () => {
    savePaneWidth(storage, MIN_WIDTH);
    expect(loadPaneWidth(storage)).toBe(MIN_WIDTH);
  });

  it("accepts the exact max boundary", () => {
    savePaneWidth(storage, MAX_WIDTH);
    expect(loadPaneWidth(storage)).toBe(MAX_WIDTH);
  });

  it("uses the canonical key", () => {
    savePaneWidth(storage, 350);
    expect(storage.getItem("helmsman.chatPane.width")).toBe("350");
  });
});
