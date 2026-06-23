import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { buildCodexArgs, mapCodexEvent, codexBridge } from "./codex.js";

describe("buildCodexArgs", () => {
  test("emits the headless read-only-via-shim flag set + prompt", () => {
    const argv = buildCodexArgs("list pods", { model: "gpt-5-codex", prompt: "list pods" } as any);
    expect(argv[0]).toBe("codex");
    expect(argv[1]).toBe("exec");
    expect(argv).toContain("--json");
    expect(argv).not.toContain("-a");
    expect(argv).toContain("approval_policy=never");
    expect(argv).toContain("sandbox_mode=workspace-write");
    expect(argv).toContain("sandbox_workspace_write.network_access=true");
    expect(argv).toContain("--skip-git-repo-check");
    const mIdx = argv.indexOf("-m");
    expect(mIdx).toBeGreaterThan(-1);
    expect(argv[mIdx + 1]).toBe("gpt-5-codex");
    expect(argv[argv.length - 1]).toBe("list pods");
  });
  test("no -m when model is absent or a bare Claude alias", () => {
    expect(buildCodexArgs("hi", { prompt: "hi" } as any)).not.toContain("-m");
    expect(buildCodexArgs("hi", { model: "opus", prompt: "hi" } as any)).not.toContain("-m");
  });
});

describe("mapCodexEvent", () => {
  test("thread.started → session", () => {
    expect(mapCodexEvent({ type: "thread.started", thread_id: "t1" })).toEqual([{ type: "session", sessionId: "t1" }]);
  });
  test("agent_message item.completed → text", () => {
    expect(mapCodexEvent({ type: "item.completed", item: { type: "agent_message", text: "done" } })).toEqual([{ type: "text", text: "done" }]);
  });
  test("turn.failed → error", () => {
    expect(mapCodexEvent({ type: "turn.failed", error: { message: "rate limited" } })).toEqual([{ type: "error", text: "rate limited" }]);
  });
  test("transient Reconnecting errors are suppressed", () => {
    expect(mapCodexEvent({ type: "error", message: "Reconnecting... 2/5" })).toEqual([]);
  });
  test("unknown events → []", () => {
    expect(mapCodexEvent({ type: "turn.started" })).toEqual([]);
    expect(mapCodexEvent(null)).toEqual([]);
  });
});

describe("codexBridge.authEnv", () => {
  const saved = { ...process.env };
  beforeEach(() => { delete process.env.CODEX_API_KEY; });
  afterEach(() => { process.env = { ...saved }; });
  test("null without CODEX_API_KEY", () => { expect(codexBridge.authEnv()).toBeNull(); });
  test("CODEX_API_KEY env when present", () => {
    process.env.CODEX_API_KEY = "sk-codex";
    expect(codexBridge.authEnv()).toEqual({ CODEX_API_KEY: "sk-codex" });
  });
});
