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
