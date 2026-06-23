import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { claudeBridge } from "./claude.js";
import * as claudeMod from "../claude.js";

describe("claudeBridge.authEnv", () => {
  const saved = { ...process.env };
  beforeEach(() => { delete process.env.CLAUDE_CODE_OAUTH_TOKEN; delete process.env.ANTHROPIC_API_KEY; });
  afterEach(() => { process.env = { ...saved }; });

  test("null when no credential is present", () => {
    expect(claudeBridge.authEnv()).toBeNull();
  });
  test("returns the OAuth token env when present", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "tok-123";
    expect(claudeBridge.authEnv()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "tok-123" });
  });
  test("returns the API key env when only that is present", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-1";
    expect(claudeBridge.authEnv()).toEqual({ ANTHROPIC_API_KEY: "sk-ant-1" });
  });
});

describe("claudeBridge.run", () => {
  afterEach(() => vi.restoreAllMocks());

  test("maps a successful runClaude result onto ProviderResult", async () => {
    vi.spyOn(claudeMod, "runClaude").mockResolvedValue({
      text: "all good", costUsd: 0.02, isError: false, sessionId: "sess-1",
      structuredOutput: { decision: "approve", confidence: 0.9, reason: "ok" },
    });
    const r = await claudeBridge.run({
      model: "claude-opus-4-8", prompt: "check", systemPrompt: "sys",
      allowedReads: ["Bash(kubectl get *)"], structuredSchema: "{}", resumeSessionId: "prev",
    });
    expect(r.isError).toBe(false);
    expect(r.text).toBe("all good");
    expect(r.costUsd).toBe(0.02);
    expect(r.sessionId).toBe("sess-1");
    expect(r.structuredOutput).toEqual({ decision: "approve", confidence: 0.9, reason: "ok" });
  });

  test("forwards model/allowedTools/jsonSchema/resume to runClaude", async () => {
    const spy = vi.spyOn(claudeMod, "runClaude").mockResolvedValue({ text: "x", costUsd: 0, isError: false });
    await claudeBridge.run({
      model: "claude-sonnet-4-6", prompt: "p", systemPrompt: "s",
      allowedReads: ["Bash(kubectl get *)"], structuredSchema: "SCHEMA", resumeSessionId: "r1", timeoutMs: 1234,
    });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      model: "claude-sonnet-4-6", prompt: "p", appendSystemPrompt: "s",
      allowedTools: ["Bash(kubectl get *)"], jsonSchema: "SCHEMA", resumeSessionId: "r1", timeoutMs: 1234,
    }));
  });

  test("a thrown runClaude error becomes a fail-closed ProviderResult (no throw)", async () => {
    vi.spyOn(claudeMod, "runClaude").mockRejectedValue(new Error("claude exited 1: 401 unauthorized"));
    const r = await claudeBridge.run({ model: "claude-opus-4-8", prompt: "x" });
    expect(r.isError).toBe(true);
    expect(r.errorMessage).toMatch(/401 unauthorized/);
    expect(r.text).toBe("");
  });
});
