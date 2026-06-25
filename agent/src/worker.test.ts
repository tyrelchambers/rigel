import { describe, expect, test, vi, afterEach } from "vitest";
import { runWorker } from "./worker.js";
import * as runModelMod from "./runModel.js";
import type { RuntimeConfig } from "./runtimeConfig.js";
import type { Incident } from "./detector.js";

function rc(): RuntimeConfig {
  return {
    enabled: true, mode: "auto", silenced: new Set(), signalRecipients: [], signalInbound: false, alertRules: [],
    worker: { provider: "claude", model: "claude-sonnet-4-6" },
    supervisor: { provider: "claude", model: "claude-opus-4-8" },
    limits: { pollIntervalMs: 30000, maxPerResourcePerHour: 3, maxPerNight: 20, maxAttemptsPerIncident: 3, confirmPolls: 2, namespaces: [] },
  } as RuntimeConfig;
}
const INC: Incident = { incidentKind: "unhealthyPod", name: "nginx", namespace: "default", reason: "CrashLoopBackOff" } as Incident;

afterEach(() => vi.restoreAllMocks());

describe("runWorker", () => {
  test("calls runModel as the worker role with the read-only tools + system prompt", async () => {
    const spy = vi.spyOn(runModelMod, "runModel").mockResolvedValue({
      text: 'all good ```action\n{"label":"restart","kind":"restart","deployment":"nginx","namespace":"default"}\n```',
      costUsd: 0.01, isError: false,
    });
    const out = await runWorker(rc(), [INC]);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ role: "worker" }));
    const call = spy.mock.calls[0]![0];
    expect(call.allowedReads).toContain("Bash(kubectl get *)");
    expect(call.systemPrompt).toMatch(/autonomous/i);
    expect(out.actions.length).toBe(1);
    expect(out.actions[0]!.kind).toBe("restart");
  });

  test("a fail-closed runModel result surfaces as an error analysis (no actions)", async () => {
    vi.spyOn(runModelMod, "runModel").mockResolvedValue({
      text: "", costUsd: 0, isError: true, errorMessage: "worker provider gemini has no credential",
    });
    const out = await runWorker(rc(), [INC]);
    expect(out.actions).toEqual([]);
    expect(out.analysis).toMatch(/no credential/);
  });
});
