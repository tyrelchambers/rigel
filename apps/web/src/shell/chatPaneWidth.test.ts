/**
 * Tests for ChatPane width persistence helpers.
 * Exercises the real load/save helpers from ./chatPaneWidth: load/save to
 * localStorage, clamping to 280–520.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  loadPaneWidth,
  savePaneWidth,
  PANE_WIDTH_KEY,
  MIN_WIDTH,
  MAX_WIDTH,
  DEFAULT_WIDTH,
} from "./chatPaneWidth";

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
    // The real helpers read/write the global localStorage (env is "node").
    globalThis.localStorage = storage;
  });

  it("returns default (360) when storage is empty", () => {
    expect(loadPaneWidth()).toBe(DEFAULT_WIDTH);
  });

  it("round-trips a valid width", () => {
    savePaneWidth(400);
    expect(loadPaneWidth()).toBe(400);
  });

  it("clamps below minimum to 280", () => {
    savePaneWidth(100);
    expect(loadPaneWidth()).toBe(MIN_WIDTH);
  });

  it("clamps above maximum to 520", () => {
    savePaneWidth(9999);
    expect(loadPaneWidth()).toBe(MAX_WIDTH);
  });

  it("returns default for non-numeric stored value", () => {
    storage.setItem(PANE_WIDTH_KEY, "not-a-number");
    expect(loadPaneWidth()).toBe(DEFAULT_WIDTH);
  });

  it("accepts the exact min boundary", () => {
    savePaneWidth(MIN_WIDTH);
    expect(loadPaneWidth()).toBe(MIN_WIDTH);
  });

  it("accepts the exact max boundary", () => {
    savePaneWidth(MAX_WIDTH);
    expect(loadPaneWidth()).toBe(MAX_WIDTH);
  });

  it("uses the canonical key", () => {
    savePaneWidth(350);
    expect(storage.getItem("rigel.chatPane.width")).toBe("350");
  });
});
