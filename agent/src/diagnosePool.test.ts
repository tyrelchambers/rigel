import { describe, it, expect } from "vitest";
import { diagnoseConfirmed, type DiagnoseDeps } from "./diagnosePool.js";
import type { Incident } from "./detector.js";
import type { SuggestedAction } from "./action.js";

function incident(name: string): Incident {
  return { incidentKind: "unhealthyPod", namespace: "default", name, reason: "CrashLoopBackOff", detail: "" };
}

const action = (label: string): SuggestedAction => ({ label, kind: "restart" }) as SuggestedAction;

describe("diagnoseConfirmed", () => {
  it("returns one packet per incident in input order, even when slow ones finish last", async () => {
    const order = ["a", "b", "c"];
    const deps: DiagnoseDeps = {
      diagnose: async (i) => {
        // "a" is slowest so it resolves last, proving order comes from input.
        const delay = i.name === "a" ? 20 : i.name === "b" ? 10 : 0;
        await new Promise((r) => setTimeout(r, delay));
        return { analysis: `diag-${i.name}`, actions: [action(i.name)], costUsd: 1, verdict: "actionable", verdictReason: "r", failed: false };
      },
      limit: 3,
    };
    const packets = await diagnoseConfirmed(deps, order.map(incident));
    expect(packets.map((p) => p.incident.name)).toEqual(["a", "b", "c"]);
    expect(packets.map((p) => p.analysis)).toEqual(["diag-a", "diag-b", "diag-c"]);
    expect(packets.map((p) => p.verdict)).toEqual(["actionable", "actionable", "actionable"]);
  });

  it("runs diagnoses concurrently up to the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const deps: DiagnoseDeps = {
      diagnose: async (i) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { analysis: i.name, actions: [], costUsd: 1, verdict: "uncertain", verdictReason: "", failed: false };
      },
      limit: 2,
    };
    await diagnoseConfirmed(deps, ["a", "b", "c", "d"].map(incident));
    expect(peak).toBe(2);
  });

  it("captures a worker THROW as an error packet (fail-closed), defaulting verdict to uncertain", async () => {
    const deps: DiagnoseDeps = {
      diagnose: async () => {
        throw new Error("401 unauthorized");
      },
      limit: 3,
    };
    const [p] = await diagnoseConfirmed(deps, [incident("a")]);
    expect(p!.error).toContain("401");
    expect(p!.actions).toEqual([]);
    expect(p!.verdict).toBe("uncertain");
    expect(p!.failed).toBe(false);
  });

  it("passes through the worker's verdict + failed flag for a failed (non-throwing) call", async () => {
    const deps: DiagnoseDeps = {
      diagnose: async () => ({ analysis: "no credential", actions: [], costUsd: 0, verdict: "uncertain", verdictReason: "no credential", failed: true }),
      limit: 3,
    };
    const [p] = await diagnoseConfirmed(deps, [incident("a")]);
    expect(p!.failed).toBe(true);
    expect(p!.error).toBeUndefined();
    expect(p!.verdictReason).toBe("no credential");
  });
});
