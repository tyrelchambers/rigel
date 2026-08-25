import { describe, it, expect, vi, afterEach } from "vitest";

async function load(platform = "MacIntel") {
  vi.resetModules();
  vi.doMock("@/lib/desktop", () => ({ rigel: undefined }));
  vi.stubGlobal("navigator", { platform, userAgentData: undefined });
  return import("./record");
}

function key(init: { key: string; code?: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }): KeyboardEvent {
  return {
    key: init.key,
    code: init.code ?? "",
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
  } as KeyboardEvent;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("specFromEvent", () => {
  it("ignores a bare modifier press", async () => {
    const { specFromEvent } = await load();
    for (const k of ["Meta", "Control", "Alt", "Shift"]) {
      expect(specFromEvent(key({ key: k, metaKey: true }))).toBeNull();
    }
  });

  it("ignores Escape so it can cancel recording", async () => {
    const { specFromEvent } = await load();
    expect(specFromEvent(key({ key: "Escape" }))).toBeNull();
  });

  it("captures Command as mod on macOS", async () => {
    const { specFromEvent } = await load();
    expect(specFromEvent(key({ key: "p", code: "KeyP", metaKey: true, shiftKey: true }))).toEqual({
      mod: true,
      ctrl: false,
      alt: false,
      shift: true,
      key: "P",
    });
  });

  it("captures Control separately from mod on macOS", async () => {
    const { specFromEvent } = await load();
    expect(specFromEvent(key({ key: "`", code: "Backquote", ctrlKey: true }))).toEqual({
      mod: false,
      ctrl: true,
      alt: false,
      shift: false,
      key: "`",
    });
  });

  it("captures Control as mod on Windows", async () => {
    const { specFromEvent } = await load("Win32");
    expect(specFromEvent(key({ key: "p", code: "KeyP", ctrlKey: true }))).toEqual({
      mod: true,
      ctrl: false,
      alt: false,
      shift: false,
      key: "P",
    });
  });

  it("reads the letter from e.code when Alt mutates e.key", async () => {
    const { specFromEvent } = await load();
    expect(specFromEvent(key({ key: "∑", code: "KeyW", metaKey: true, altKey: true }))?.key).toBe("W");
  });

  it("keeps named keys as-is", async () => {
    const { specFromEvent } = await load();
    expect(specFromEvent(key({ key: "F2", code: "F2" }))?.key).toBe("F2");
  });

  it("reads digits from e.code", async () => {
    const { specFromEvent } = await load();
    expect(specFromEvent(key({ key: "1", code: "Digit1", metaKey: true }))?.key).toBe("1");
  });
});

describe("hasModifier", () => {
  it("is false for a bare or shift-only binding", async () => {
    const { hasModifier } = await load();
    expect(hasModifier({ key: "F2" })).toBe(false);
    expect(hasModifier({ shift: true, key: "F2" })).toBe(false);
  });

  it("is true for mod, ctrl, or alt", async () => {
    const { hasModifier } = await load();
    expect(hasModifier({ mod: true, key: "K" })).toBe(true);
    expect(hasModifier({ ctrl: true, key: "`" })).toBe(true);
    expect(hasModifier({ alt: true, key: "W" })).toBe(true);
  });
});
