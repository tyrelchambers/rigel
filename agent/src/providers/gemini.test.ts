import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { buildGeminiArgs, mapGeminiEvent, geminiBridge } from "./gemini.js";

describe("buildGeminiArgs", () => {
  test("headless stream-json + yolo + model", () => {
    const argv = buildGeminiArgs("why crash?", { model: "gemini-2.5-pro", prompt: "why crash?" } as any);
    expect(argv[0]).toBe("gemini");
    expect(argv).toContain("-p");
    expect(argv).toContain("-o");
    expect(argv).toContain("stream-json");
    expect(argv).toContain("--approval-mode");
    expect(argv).toContain("yolo");
    const mIdx = argv.indexOf("-m");
    expect(argv[mIdx + 1]).toBe("gemini-2.5-pro");
  });
  test("no -m for a bare Claude alias or absent model", () => {
    expect(buildGeminiArgs("hi", { model: "sonnet", prompt: "hi" } as any)).not.toContain("-m");
    expect(buildGeminiArgs("hi", { prompt: "hi" } as any)).not.toContain("-m");
  });
});

describe("mapGeminiEvent", () => {
  test("init → session", () => {
    expect(mapGeminiEvent({ type: "init", session_id: "g1" })).toEqual([{ type: "session", sessionId: "g1" }]);
  });
  test("assistant message → text", () => {
    expect(mapGeminiEvent({ type: "message", role: "assistant", content: "hello" })).toEqual([{ type: "text", text: "hello" }]);
  });
  test("user message → ignored", () => {
    expect(mapGeminiEvent({ type: "message", role: "user", content: "echo" })).toEqual([]);
  });
  test("error severity error → error; warning → ignored", () => {
    expect(mapGeminiEvent({ type: "error", severity: "error", message: "boom" })).toEqual([{ type: "error", text: "boom" }]);
    expect(mapGeminiEvent({ type: "error", severity: "warning", message: "meh" })).toEqual([]);
  });
  test("result status error → error then done; success → done", () => {
    expect(mapGeminiEvent({ type: "result", status: "error", error: { message: "fail" } })).toEqual([
      { type: "error", text: "fail" }, { type: "done" },
    ]);
    expect(mapGeminiEvent({ type: "result", status: "success" })).toEqual([{ type: "done" }]);
  });
});

describe("geminiBridge.authEnv", () => {
  const saved = { ...process.env };
  beforeEach(() => { delete process.env.GEMINI_API_KEY; });
  afterEach(() => { process.env = { ...saved }; });
  test("null without GEMINI_API_KEY", () => { expect(geminiBridge.authEnv()).toBeNull(); });
  test("GEMINI_API_KEY when present", () => {
    process.env.GEMINI_API_KEY = "g-key";
    expect(geminiBridge.authEnv()).toEqual({ GEMINI_API_KEY: "g-key" });
  });
});
