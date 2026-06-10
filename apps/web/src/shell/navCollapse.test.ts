import { describe, it, expect, beforeEach } from "vitest";
import {
  ALL_GROUP_TITLES,
  defaultCollapsed,
  fromStorage,
  toStorage,
  isCollapsed,
  toggle,
  revealPanel,
  NAV_COLLAPSE_KEY,
  loadCollapsed,
  saveCollapsed,
} from "./navCollapse";

// ─── first-launch-collapsed ──────────────────────────────────────────────────

describe("defaultCollapsed", () => {
  it("collapses every titled group on first launch", () => {
    const state = defaultCollapsed();
    for (const title of ALL_GROUP_TITLES) {
      expect(isCollapsed(state, title)).toBe(true);
    }
  });

  it("does not include the pinned (title-less) group", () => {
    const state = defaultCollapsed();
    // The pinned group has no title — it's not in the collapsed set.
    expect(isCollapsed(state, "")).toBe(false);
    expect(isCollapsed(state, "_pinned")).toBe(false);
  });

  it("collapses all 7 titled groups", () => {
    const state = defaultCollapsed();
    expect(state.collapsed.size).toBe(ALL_GROUP_TITLES.length);
  });
});

// ─── toggle ──────────────────────────────────────────────────────────────────

describe("toggle", () => {
  it("expands a collapsed group", () => {
    const state = defaultCollapsed();
    const next = toggle(state, "Workloads");
    expect(isCollapsed(next, "Workloads")).toBe(false);
  });

  it("collapses an expanded group", () => {
    const state = { collapsed: new Set<string>() };
    const next = toggle(state, "Workloads");
    expect(isCollapsed(next, "Workloads")).toBe(true);
  });

  it("does not mutate the original state", () => {
    const state = defaultCollapsed();
    const sizeBefore = state.collapsed.size;
    toggle(state, "Workloads");
    expect(state.collapsed.size).toBe(sizeBefore);
  });

  it("toggling twice restores the original", () => {
    const state = defaultCollapsed();
    const twice = toggle(toggle(state, "Networking"), "Networking");
    expect(isCollapsed(twice, "Networking")).toBe(isCollapsed(state, "Networking"));
  });
});

// ─── persist ─────────────────────────────────────────────────────────────────

describe("storage round-trip", () => {
  it("serialises to sorted comma-joined string", () => {
    const state = fromStorage("Workloads,Networking");
    expect(toStorage(state)).toBe("Networking,Workloads");
  });

  it("empty string yields empty collapsed set", () => {
    const state = fromStorage("");
    expect(state.collapsed.size).toBe(0);
  });

  it("round-trips defaultCollapsed", () => {
    const original = defaultCollapsed();
    const roundTripped = fromStorage(toStorage(original));
    expect(roundTripped.collapsed).toEqual(original.collapsed);
  });

  it("ignores blank/whitespace segments", () => {
    const state = fromStorage(" , ,Workloads, ");
    expect(state.collapsed.size).toBe(1);
    expect(isCollapsed(state, "Workloads")).toBe(true);
  });
});

// ─── auto-expand active ──────────────────────────────────────────────────────

describe("revealPanel", () => {
  it("expands the group containing the active route", () => {
    const state = defaultCollapsed();
    const next = revealPanel(state, "deployments");
    expect(isCollapsed(next, "Workloads")).toBe(false);
  });

  it("is a no-op for the pinned group (overview/assistant)", () => {
    const state = defaultCollapsed();
    const next = revealPanel(state, "overview");
    expect(toStorage(next)).toBe(toStorage(state));
  });

  it("is a no-op when the group is already expanded", () => {
    const state = toggle(defaultCollapsed(), "Observability"); // now expanded
    const next = revealPanel(state, "logs");
    expect(isCollapsed(next, "Observability")).toBe(false);
    expect(toStorage(next)).toBe(toStorage(state));
  });

  it("does not expand other groups", () => {
    const state = defaultCollapsed();
    const next = revealPanel(state, "pods"); // Workloads
    // Networking should still be collapsed
    expect(isCollapsed(next, "Networking")).toBe(true);
  });

  it("handles unknown panel route gracefully", () => {
    const state = defaultCollapsed();
    const next = revealPanel(state, "nonexistent");
    expect(toStorage(next)).toBe(toStorage(state));
  });
});

// ─── localStorage helpers ────────────────────────────────────────────────────

// Vitest runs in Node — stub localStorage like the other tests in this project.
function makeLocalStorage() {
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

describe("loadCollapsed / saveCollapsed", () => {
  beforeEach(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = makeLocalStorage();
  });

  it("returns first-launch default when localStorage is empty", () => {
    const state = loadCollapsed();
    expect(state.collapsed.size).toBe(ALL_GROUP_TITLES.length);
  });

  it("persists and reloads correctly", () => {
    const state = toggle(defaultCollapsed(), "Workloads");
    saveCollapsed(state);
    const loaded = loadCollapsed();
    expect(isCollapsed(loaded, "Workloads")).toBe(false);
    expect(isCollapsed(loaded, "Networking")).toBe(true);
  });

  it("uses the canonical localStorage key", () => {
    const state = defaultCollapsed();
    saveCollapsed(state);
    expect(localStorage.getItem(NAV_COLLAPSE_KEY)).toBeTruthy();
  });
});
