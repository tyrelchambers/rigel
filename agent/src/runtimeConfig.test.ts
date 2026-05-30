import { describe, expect, test } from "vitest";
import { parseWindow, inWindow, decideAutonomy } from "./runtimeConfig.js";

describe("parseWindow", () => {
  test("parses HH:MM-HH:MM into minutes-of-day", () => {
    expect(parseWindow("22:00-07:00")).toEqual({ startMin: 1320, endMin: 420 });
    expect(parseWindow("09:30-17:00")).toEqual({ startMin: 570, endMin: 1020 });
  });
  test("returns null on malformed input", () => {
    expect(parseWindow("")).toBeNull();
    expect(parseWindow("nonsense")).toBeNull();
    expect(parseWindow("25:00-07:00")).toBeNull();
  });
});

describe("inWindow", () => {
  test("same-day window", () => {
    const w = { startMin: 570, endMin: 1020 }; // 09:30-17:00
    expect(inWindow(600, w)).toBe(true); // 10:00
    expect(inWindow(540, w)).toBe(false); // 09:00
    expect(inWindow(1020, w)).toBe(false); // 17:00 exclusive end
  });
  test("overnight window (wraps midnight)", () => {
    const w = { startMin: 1320, endMin: 420 }; // 22:00-07:00
    expect(inWindow(1380, w)).toBe(true); // 23:00
    expect(inWindow(60, w)).toBe(true); // 01:00
    expect(inWindow(720, w)).toBe(false); // 12:00
  });
});

describe("decideAutonomy", () => {
  const w = { startMin: 1320, endMin: 420 }; // overnight
  test("auto mode always allows auto-execute", () => {
    expect(decideAutonomy("auto", undefined, 720)).toBe("auto");
  });
  test("advisory mode always queues", () => {
    expect(decideAutonomy("advisory", undefined, 60)).toBe("queue");
  });
  test("window mode auto-executes only inside the window", () => {
    expect(decideAutonomy("window", w, 60)).toBe("auto"); // 01:00 inside
    expect(decideAutonomy("window", w, 720)).toBe("queue"); // 12:00 outside
  });
  test("window mode with no window falls back to queue (safe)", () => {
    expect(decideAutonomy("window", undefined, 60)).toBe("queue");
  });
});
