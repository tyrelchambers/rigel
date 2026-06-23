import { describe, expect, test, vi, afterEach } from "vitest";
import { runModel } from "./runModel.js";
import { claudeBridge } from "./providers/claude.js";
import { geminiBridge } from "./providers/gemini.js";
import type { RuntimeConfig } from "./runtimeConfig.js";

function rc(over: Partial<RuntimeConfig>): RuntimeConfig {
  return {
    enabled: true, mode: "auto", silenced: new Set(), signalRecipients: [], signalInbound: false, alertRules: [],
    worker: { provider: "claude", model: "claude-sonnet-4-6" },
    supervisor: { provider: "claude", model: "claude-opus-4-8" },
    limits: { pollIntervalMs: 30000, maxPerResourcePerHour: 3, maxPerNight: 20, maxAttemptsPerIncident: 3, confirmPolls: 2, namespaces: [] },
    ...over,
  } as RuntimeConfig;
}

afterEach(() => vi.restoreAllMocks());

describe("runModel dispatch", () => {
  test("routes the worker role to its provider bridge with model+systemPrompt+reads", async () => {
    const spy = vi.spyOn(claudeBridge, "authEnv").mockReturnValue({ CLAUDE_CODE_OAUTH_TOKEN: "t" });
    const runSpy = vi.spyOn(claudeBridge, "run").mockResolvedValue({ text: "ok", costUsd: 0, isError: false });
    const r = await runModel({
      role: "worker", config: rc({ worker: { provider: "claude", model: "claude-sonnet-4-6" } }),
      prompt: "p", systemPrompt: "sys", allowedReads: ["Bash(kubectl get *)"],
    });
    expect(r.isError).toBe(false);
    expect(runSpy).toHaveBeenCalledWith(expect.objectContaining({
      model: "claude-sonnet-4-6", prompt: "p", systemPrompt: "sys", allowedReads: ["Bash(kubectl get *)"],
    }));
    spy.mockRestore();
  });

  test("fails closed with a clear message when the selected provider has no credential", async () => {
    vi.spyOn(geminiBridge, "authEnv").mockReturnValue(null);
    const r = await runModel({ role: "worker", config: rc({ worker: { provider: "gemini", model: "gemini-2.5-pro" } }), prompt: "p" });
    expect(r.isError).toBe(true);
    expect(r.errorMessage).toMatch(/gemini/i);
    expect(r.errorMessage).toMatch(/key|credential/i);
  });

  test("Claude structured path passes structuredSchema straight through (no reprompt)", async () => {
    vi.spyOn(claudeBridge, "authEnv").mockReturnValue({ CLAUDE_CODE_OAUTH_TOKEN: "t" });
    const runSpy = vi.spyOn(claudeBridge, "run").mockResolvedValue({
      text: "{}", costUsd: 0, isError: false, structuredOutput: { decision: "approve" },
    });
    const r = await runModel({
      role: "supervisor", config: rc({ supervisor: { provider: "claude", model: "claude-opus-4-8" } }),
      prompt: "p", structuredSchema: "SCHEMA", validateStructured: (o: any) => o?.decision === "approve",
    });
    expect(r.structuredOutput).toEqual({ decision: "approve" });
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0]![0].structuredSchema).toBe("SCHEMA");
  });

  test("non-Claude structured: reprompts ONCE on a bad verdict, then succeeds", async () => {
    vi.spyOn(geminiBridge, "authEnv").mockReturnValue({ GEMINI_API_KEY: "k" });
    const runSpy = vi.spyOn(geminiBridge, "run")
      .mockResolvedValueOnce({ text: "garbage", costUsd: 0, isError: false, structuredOutput: undefined })
      .mockResolvedValueOnce({ text: "{}", costUsd: 0, isError: false, structuredOutput: { decision: "reject" } });
    const r = await runModel({
      role: "supervisor", config: rc({ supervisor: { provider: "gemini", model: "gemini-2.5-pro" } }),
      prompt: "p", structuredSchema: "SCHEMA", validateStructured: (o: any) => o?.decision === "reject",
    });
    expect(runSpy).toHaveBeenCalledTimes(2);
    expect(r.isError).toBe(false);
    expect(r.structuredOutput).toEqual({ decision: "reject" });
  });

  test("non-Claude structured: a second bad verdict fails closed (caller escalates)", async () => {
    vi.spyOn(geminiBridge, "authEnv").mockReturnValue({ GEMINI_API_KEY: "k" });
    vi.spyOn(geminiBridge, "run").mockResolvedValue({ text: "still bad", costUsd: 0, isError: false, structuredOutput: undefined });
    const r = await runModel({
      role: "supervisor", config: rc({ supervisor: { provider: "gemini", model: "gemini-2.5-pro" } }),
      prompt: "p", structuredSchema: "SCHEMA", validateStructured: () => false,
    });
    expect(r.isError).toBe(true);
    expect(r.errorMessage).toMatch(/structured|verdict|valid/i);
  });
});
