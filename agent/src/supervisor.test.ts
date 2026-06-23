import { describe, expect, test, vi, afterEach } from "vitest";
import { parseVerdict, runSupervisor } from "./supervisor.js";
import * as runModelMod from "./runModel.js";
import type { RuntimeConfig } from "./runtimeConfig.js";
import type { Incident } from "./detector.js";
import type { SuggestedAction } from "./action.js";

describe("parseVerdict", () => {
  test("accepts a well-formed approve verdict", () => {
    expect(parseVerdict({ decision: "approve", confidence: 0.92, reason: "rollback matches the bad rollout" })).toEqual({
      decision: "approve",
      confidence: 0.92,
      reason: "rollback matches the bad rollout",
    });
  });

  test("accepts reject and escalate decisions", () => {
    expect(parseVerdict({ decision: "reject", confidence: 0.4, reason: "no evidence" }).decision).toBe("reject");
    expect(parseVerdict({ decision: "escalate", confidence: 0.5, reason: "needs a human" }).decision).toBe("escalate");
  });

  test("clamps confidence into [0,1]", () => {
    expect(parseVerdict({ decision: "approve", confidence: 1.7, reason: "x" }).confidence).toBe(1);
    expect(parseVerdict({ decision: "approve", confidence: -3, reason: "x" }).confidence).toBe(0);
  });

  test("defaults a missing/non-numeric confidence to 0 (treated as low)", () => {
    expect(parseVerdict({ decision: "approve", reason: "x" }).confidence).toBe(0);
  });

  test("throws on an unknown decision (fail-closed)", () => {
    expect(() => parseVerdict({ decision: "yolo", confidence: 1, reason: "x" })).toThrow();
  });

  test("throws on a non-object", () => {
    expect(() => parseVerdict(null)).toThrow();
    expect(() => parseVerdict("approve")).toThrow();
  });
});

function rc(): RuntimeConfig {
  return {
    enabled: true, mode: "auto", silenced: new Set(), signalRecipients: [], signalInbound: false, alertRules: [],
    worker: { provider: "claude", model: "claude-sonnet-4-6" },
    supervisor: { provider: "claude", model: "claude-opus-4-8" },
    limits: { pollIntervalMs: 30000, maxPerResourcePerHour: 3, maxPerNight: 20, maxAttemptsPerIncident: 3, confirmPolls: 2, namespaces: [] },
  } as RuntimeConfig;
}
const INC = { incidentKind: "degradedDeployment", name: "api", namespace: "default", reason: "Unavailable" } as Incident;
const ACT = { label: "rollback api", kind: "rollback", deployment: "api", namespace: "default" } as SuggestedAction;

describe("runSupervisor", () => {
  afterEach(() => vi.restoreAllMocks());

  test("calls runModel as supervisor with the verdict schema + a validator", async () => {
    const spy = vi.spyOn(runModelMod, "runModel").mockResolvedValue({
      text: "{}", costUsd: 0, isError: false, structuredOutput: { decision: "approve", confidence: 0.9, reason: "ok" },
    });
    const out = await runSupervisor(rc(), INC, ACT, "analysis", "kubectl rollout undo deploy/api");
    const call = spy.mock.calls[0][0];
    expect(call.role).toBe("supervisor");
    expect(typeof call.structuredSchema).toBe("string");
    expect(typeof call.validateStructured).toBe("function");
    expect(out.verdict.decision).toBe("approve");
  });

  test("normalizes the success-path verdict (clamps out-of-range confidence)", async () => {
    vi.spyOn(runModelMod, "runModel").mockResolvedValue({
      text: "{}", costUsd: 0, isError: false, structuredOutput: { decision: "reject", confidence: 1.5, reason: "too risky" },
    });
    const out = await runSupervisor(rc(), INC, ACT, "a", "cmd");
    expect(out.verdict.confidence).toBe(1);
    expect(out.verdict.decision).toBe("reject");
  });

  test("the validator rejects a malformed verdict (so runModel would reprompt/escalate)", async () => {
    // The mock returns a VALID verdict so runSupervisor completes — the test only needs to
    // capture the validator and exercise it directly (an invalid verdict can't reach the
    // success path in production: validateStructured would fail → reprompt → fail-closed).
    const spy = vi.spyOn(runModelMod, "runModel").mockResolvedValue({ text: "x", costUsd: 0, isError: false, structuredOutput: { decision: "approve", confidence: 0.5, reason: "ok" } });
    await runSupervisor(rc(), INC, ACT, "a", "cmd");
    const validate = spy.mock.calls[0][0].validateStructured!;
    expect(validate({ decision: "approve", confidence: 0.9, reason: "ok" })).toBe(true);
    expect(validate({ decision: "yolo" })).toBe(false);
    expect(validate("not even an object")).toBe(false);
  });

  test("a fail-closed runModel result THROWS so the loop escalates (never auto-approves)", async () => {
    vi.spyOn(runModelMod, "runModel").mockResolvedValue({ text: "", costUsd: 0, isError: true, errorMessage: "no valid verdict after reprompt" });
    await expect(runSupervisor(rc(), INC, ACT, "a", "cmd")).rejects.toThrow(/verdict/i);
  });
});
