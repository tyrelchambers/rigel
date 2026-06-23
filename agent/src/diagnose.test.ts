import { describe, expect, test, vi, afterEach } from "vitest";
import { runDiagnosis } from "./diagnose.js";
import * as runModelMod from "./runModel.js";
import type { RuntimeConfig } from "./runtimeConfig.js";

function rc(): RuntimeConfig {
  return {
    enabled: true, mode: "auto", silenced: new Set(), signalRecipients: [], signalInbound: false, alertRules: [],
    worker: { provider: "claude", model: "claude-sonnet-4-6" },
    supervisor: { provider: "claude", model: "claude-opus-4-8" },
    limits: { pollIntervalMs: 30000, maxPerResourcePerHour: 3, maxPerNight: 20, maxAttemptsPerIncident: 3, confirmPolls: 2, namespaces: [] },
  } as RuntimeConfig;
}

afterEach(() => vi.restoreAllMocks());

describe("runDiagnosis", () => {
  test("runs the worker role, threads the resume session id, returns text + sessionId", async () => {
    const spy = vi.spyOn(runModelMod, "runModel").mockResolvedValue({ text: "nginx is healthy", costUsd: 0.005, isError: false, sessionId: "sess-9" });
    const out = await runDiagnosis(rc(), "is nginx ok?", "prev-sess");
    const call = spy.mock.calls[0][0];
    expect(call.role).toBe("worker");
    expect(call.resumeSessionId).toBe("prev-sess");
    expect(call.allowedReads).toContain("Bash(kubectl get *)");
    expect(out.text).toBe("nginx is healthy");
    expect(out.sessionId).toBe("sess-9");
  });

  test("throws on a fail-closed result so the caller replies with an error, not silence", async () => {
    vi.spyOn(runModelMod, "runModel").mockResolvedValue({ text: "", costUsd: 0, isError: true, errorMessage: "gemini has no key" });
    await expect(runDiagnosis(rc(), "q")).rejects.toThrow(/gemini has no key/);
  });
});
