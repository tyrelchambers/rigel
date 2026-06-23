import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { buildOpencodeArgs, mapOpencodeEvent, opencodeBridge } from "./opencode.js";

describe("buildOpencodeArgs", () => {
  test("headless json + thinking + dir + model + trailing prompt", () => {
    const argv = buildOpencodeArgs("hi", { model: "anthropic/claude-x", prompt: "hi" } as any, "/run/dir");
    expect(argv.slice(0, 2)).toEqual(["opencode", "run"]);
    expect(argv).toContain("--format");
    expect(argv).toContain("json");
    expect(argv).toContain("--thinking");
    const dIdx = argv.indexOf("--dir");
    expect(argv[dIdx + 1]).toBe("/run/dir");
    const mIdx = argv.indexOf("-m");
    expect(argv[mIdx + 1]).toBe("anthropic/claude-x");
    expect(argv[argv.length - 1]).toBe("hi");
  });
  test("resume inserts -s <sessionId>", () => {
    const argv = buildOpencodeArgs("go", { resumeSessionId: "oc1", prompt: "go" } as any, "/d");
    const sIdx = argv.indexOf("-s");
    expect(argv[sIdx + 1]).toBe("oc1");
  });
  test("no -m for a bare Claude alias", () => {
    expect(buildOpencodeArgs("hi", { model: "opus", prompt: "hi" } as any, "/d")).not.toContain("-m");
  });
});

describe("mapOpencodeEvent", () => {
  test("text part → text", () => {
    expect(mapOpencodeEvent({ type: "text", part: { text: "answer" } })).toEqual([{ type: "text", text: "answer" }]);
  });
  test("step_start with sessionID → session", () => {
    expect(mapOpencodeEvent({ type: "step_start", sessionID: "oc9" })).toEqual([{ type: "session", sessionId: "oc9" }]);
  });
  test("error → error (structured message preferred)", () => {
    expect(mapOpencodeEvent({ type: "error", error: { data: { message: "no creds" } } })).toEqual([{ type: "error", text: "no creds" }]);
  });
  test("unknown → []", () => {
    expect(mapOpencodeEvent({ type: "step_finish" })).toEqual([]);
    expect(mapOpencodeEvent(null)).toEqual([]);
  });
});

describe("opencodeBridge.authEnv", () => {
  const saved = { ...process.env };
  beforeEach(() => { delete process.env.OPENCODE_AUTH_CONTENT; delete process.env.OPENCODE_API_KEY; });
  afterEach(() => { process.env = { ...saved }; });
  test("null with no opencode credential", () => { expect(opencodeBridge.authEnv()).toBeNull(); });
  test("OPENCODE_AUTH_CONTENT blob when present", () => {
    process.env.OPENCODE_AUTH_CONTENT = "{...}";
    expect(opencodeBridge.authEnv()).toEqual({ OPENCODE_AUTH_CONTENT: "{...}" });
  });
  test("OPENCODE_API_KEY when present", () => {
    process.env.OPENCODE_API_KEY = "oc-key";
    expect(opencodeBridge.authEnv()).toEqual({ OPENCODE_API_KEY: "oc-key" });
  });
});
