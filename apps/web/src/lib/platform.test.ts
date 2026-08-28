import { describe, it, expect, vi, afterEach } from "vitest";

async function load(platform: string) {
  vi.resetModules();
  vi.doMock("./desktop", () => ({ rigel: undefined }));
  vi.stubGlobal("navigator", { platform, userAgentData: undefined });
  return import("./platform");
}

const SHORTCUTS = [
  { spec: { mod: true, key: "K" }, mac: "⌘K", other: "Ctrl+K" },
  { spec: { mod: true, key: "L" }, mac: "⌘L", other: "Ctrl+L" },
  { spec: { mod: true, key: "J" }, mac: "⌘J", other: "Ctrl+J" },
  { spec: { mod: true, key: "/" }, mac: "⌘/", other: "Ctrl+/" },
  { spec: { mod: true, key: "N" }, mac: "⌘N", other: "Ctrl+N" },
  { spec: { alt: true, mod: true, key: "W" }, mac: "⌥⌘W", other: "Alt+Ctrl+W" },
  { spec: { ctrl: true, key: "`" }, mac: "⌃`", other: "Ctrl+`" },
] as const;

describe("formatShortcut", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("renders Mac glyph labels on macOS", async () => {
    const { formatShortcut, isMac } = await load("MacIntel");
    expect(isMac).toBe(true);
    for (const { spec, mac } of SHORTCUTS) {
      expect(formatShortcut(spec)).toBe(mac);
    }
  });

  it("renders text labels on Windows/Linux", async () => {
    const { formatShortcut, isMac } = await load("Win32");
    expect(isMac).toBe(false);
    for (const { spec, other } of SHORTCUTS) {
      expect(formatShortcut(spec)).toBe(other);
    }
  });
});

function key(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    key: init.key,
    code: init.code ?? "",
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
  } as KeyboardEvent;
}

describe("matchShortcut on macOS", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("matches mod against the Command key", async () => {
    const { matchShortcut } = await load("MacIntel");
    expect(matchShortcut(key({ key: "k", code: "KeyK", metaKey: true }), { mod: true, key: "K" })).toBe(true);
  });

  it("does not accept Control for mod on macOS", async () => {
    const { matchShortcut } = await load("MacIntel");
    expect(matchShortcut(key({ key: "k", code: "KeyK", ctrlKey: true }), { mod: true, key: "K" })).toBe(false);
  });

  it("requires modifiers to match exactly", async () => {
    const { matchShortcut } = await load("MacIntel");
    const shifted = key({ key: "K", code: "KeyK", metaKey: true, shiftKey: true });
    expect(matchShortcut(shifted, { mod: true, key: "K" })).toBe(false);
    expect(matchShortcut(shifted, { mod: true, shift: true, key: "K" })).toBe(true);
  });

  it("matches an Alt-mutated letter through e.code", async () => {
    const { matchShortcut } = await load("MacIntel");
    const alted = key({ key: "∑", code: "KeyW", metaKey: true, altKey: true });
    expect(matchShortcut(alted, { alt: true, mod: true, key: "W" })).toBe(true);
  });

  it("matches a plain Control binding", async () => {
    const { matchShortcut } = await load("MacIntel");
    expect(matchShortcut(key({ key: "`", code: "Backquote", ctrlKey: true }), { ctrl: true, key: "`" })).toBe(true);
    expect(matchShortcut(key({ key: "`", code: "Backquote", metaKey: true }), { ctrl: true, key: "`" })).toBe(false);
  });

  it("matches named keys case-insensitively", async () => {
    const { matchShortcut } = await load("MacIntel");
    expect(matchShortcut(key({ key: "ArrowLeft", metaKey: true }), { mod: true, key: "ArrowLeft" })).toBe(true);
  });
});

describe("matchShortcut on Windows", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("matches mod against Control", async () => {
    const { matchShortcut } = await load("Win32");
    expect(matchShortcut(key({ key: "k", code: "KeyK", ctrlKey: true }), { mod: true, key: "K" })).toBe(true);
    expect(matchShortcut(key({ key: "k", code: "KeyK", metaKey: true }), { mod: true, key: "K" })).toBe(false);
  });

  it("treats a ctrl-only spec as Control", async () => {
    const { matchShortcut } = await load("Win32");
    expect(matchShortcut(key({ key: "`", code: "Backquote", ctrlKey: true }), { ctrl: true, key: "`" })).toBe(true);
  });
});
