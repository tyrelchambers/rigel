import { describe, it, expect, beforeEach, vi } from "vitest";

const KEY = "rigel.shortcuts.overrides";

async function load() {
  vi.resetModules();
  return import("./shortcuts");
}

beforeEach(() => {
  localStorage.clear();
});

describe("readOverrides", () => {
  it("returns an empty map when nothing is stored", async () => {
    const { readOverrides } = await load();
    expect(readOverrides()).toEqual({});
  });

  it("returns an empty map for malformed JSON", async () => {
    localStorage.setItem(KEY, "{not json");
    const { readOverrides } = await load();
    expect(readOverrides()).toEqual({});
  });

  it("returns an empty map when the stored value is not an object", async () => {
    localStorage.setItem(KEY, JSON.stringify(["nope"]));
    const { readOverrides } = await load();
    expect(readOverrides()).toEqual({});
  });

  it("reads a stored override", async () => {
    localStorage.setItem(KEY, JSON.stringify({ "palette.open": { mod: true, shift: true, key: "P" } }));
    const { readOverrides } = await load();
    expect(readOverrides()["palette.open"]).toEqual({ mod: true, shift: true, key: "P" });
  });
});

describe("useShortcutStore", () => {
  it("hydrates from localStorage at creation", async () => {
    localStorage.setItem(KEY, JSON.stringify({ "chat.toggle": null }));
    const { useShortcutStore } = await load();
    expect(useShortcutStore.getState().overrides).toEqual({ "chat.toggle": null });
  });

  it("writes an override through to localStorage", async () => {
    const { useShortcutStore } = await load();
    useShortcutStore.getState().setOverride("chat.toggle", { mod: true, key: "M" });
    expect(useShortcutStore.getState().overrides["chat.toggle"]).toEqual({ mod: true, key: "M" });
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}")["chat.toggle"]).toEqual({ mod: true, key: "M" });
  });

  it("stores null for an unbound command", async () => {
    const { useShortcutStore } = await load();
    useShortcutStore.getState().setOverride("chat.toggle", null);
    expect(useShortcutStore.getState().overrides).toHaveProperty("chat.toggle", null);
  });

  it("reset removes the key entirely so the default applies again", async () => {
    const { useShortcutStore } = await load();
    useShortcutStore.getState().setOverride("chat.toggle", null);
    useShortcutStore.getState().reset("chat.toggle");
    expect("chat.toggle" in useShortcutStore.getState().overrides).toBe(false);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}")).toEqual({});
  });

  it("resetAll clears everything", async () => {
    const { useShortcutStore } = await load();
    useShortcutStore.getState().setOverride("chat.toggle", { mod: true, key: "M" });
    useShortcutStore.getState().setOverride("nav.back", null);
    useShortcutStore.getState().resetAll();
    expect(useShortcutStore.getState().overrides).toEqual({});
    expect(localStorage.getItem(KEY)).toBe("{}");
  });
});
