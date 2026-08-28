import { describe, it, expect, vi, afterEach } from "vitest";

async function load(platform = "MacIntel") {
  vi.resetModules();
  vi.doMock("@/lib/desktop", () => ({ rigel: undefined }));
  vi.stubGlobal("navigator", { platform, userAgentData: undefined });
  return import("./resolve");
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

describe("resolveSpec", () => {
  it("returns the default when there is no override", async () => {
    const { resolveSpec } = await load();
    expect(resolveSpec("palette.open", {})).toEqual({ mod: true, key: "K" });
  });

  it("returns the override when one is present", async () => {
    const { resolveSpec } = await load();
    expect(resolveSpec("palette.open", { "palette.open": { mod: true, shift: true, key: "P" } })).toEqual({
      mod: true,
      shift: true,
      key: "P",
    });
  });

  it("returns null when the command is unbound", async () => {
    const { resolveSpec } = await load();
    expect(resolveSpec("palette.open", { "palette.open": null })).toBeNull();
  });
});

describe("resolveCommand", () => {
  it("maps a default binding to its command", async () => {
    const { resolveCommand } = await load();
    expect(resolveCommand(key({ key: "k", code: "KeyK", metaKey: true }), {})).toBe("palette.open");
  });

  it("maps an alias to its command", async () => {
    const { resolveCommand } = await load();
    expect(resolveCommand(key({ key: "ArrowLeft", metaKey: true }), {})).toBe("nav.back");
  });

  it("drops the aliases once the command is rebound", async () => {
    const { resolveCommand } = await load();
    const overrides = { "nav.back": { mod: true, key: "B" } } as const;
    expect(resolveCommand(key({ key: "ArrowLeft", metaKey: true }), overrides)).toBeNull();
    expect(resolveCommand(key({ key: "b", code: "KeyB", metaKey: true }), overrides)).toBe("nav.back");
  });

  it("returns null for an unbound command's old binding", async () => {
    const { resolveCommand } = await load();
    expect(resolveCommand(key({ key: "k", code: "KeyK", metaKey: true }), { "palette.open": null })).toBeNull();
  });

  it("returns null for an unclaimed combination", async () => {
    const { resolveCommand } = await load();
    expect(resolveCommand(key({ key: "q", code: "KeyQ", metaKey: true }), {})).toBeNull();
  });
});

describe("findConflict", () => {
  it("names the command already holding a combination", async () => {
    const { findConflict } = await load();
    expect(findConflict({ mod: true, key: "J" }, "voice.toggle", {})).toBe("chat.toggle");
  });

  it("does not report a command conflicting with itself", async () => {
    const { findConflict } = await load();
    expect(findConflict({ mod: true, key: "J" }, "chat.toggle", {})).toBeNull();
  });

  it("respects overrides on both sides", async () => {
    const { findConflict } = await load();
    expect(findConflict({ mod: true, key: "J" }, "voice.toggle", { "chat.toggle": null })).toBeNull();
    expect(findConflict({ mod: true, key: "M" }, "voice.toggle", { "chat.toggle": { mod: true, key: "M" } })).toBe("chat.toggle");
  });

  it("ignores aliases so ⌘← stays available to rebind onto", async () => {
    const { findConflict } = await load();
    expect(findConflict({ mod: true, key: "ArrowLeft" }, "voice.toggle", {})).toBeNull();
  });
});

describe("shortcutLabelFor", () => {
  it("formats the resolved binding", async () => {
    const { shortcutLabelFor } = await load();
    expect(shortcutLabelFor("palette.open", {})).toBe("⌘K");
  });

  it("returns null when unbound", async () => {
    const { shortcutLabelFor } = await load();
    expect(shortcutLabelFor("palette.open", { "palette.open": null })).toBeNull();
  });
});
