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
        return { analysis: `diag-${i.name}`, actions: [action(i.name)], costUsd: 1 };
      },
      canSpend: () => true,
      addSpend: () => {},
      limit: 3,
    };
    const packets = await diagnoseConfirmed(deps, order.map(incident));
    expect(packets.map((p) => p.incident.name)).toEqual(["a", "b", "c"]);
    expect(packets.map((p) => p.analysis)).toEqual(["diag-a", "diag-b", "diag-c"]);
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
        return { analysis: i.name, actions: [], costUsd: 1 };
      },
      canSpend: () => true,
      addSpend: () => {},
      limit: 2,
    };
    await diagnoseConfirmed(deps, ["a", "b", "c", "d"].map(incident));
    expect(peak).toBe(2);
  });

  it("meters spend once per successful diagnosis", async () => {
    let total = 0;
    const deps: DiagnoseDeps = {
      diagnose: async () => ({ analysis: "x", actions: [], costUsd: 0.25 }),
      canSpend: () => true,
      addSpend: (c) => (total += c),
      limit: 3,
    };
    await diagnoseConfirmed(deps, ["a", "b"].map(incident));
    expect(total).toBeCloseTo(0.5);
  });

  it("captures a worker failure as an error packet (fail-closed) without spending", async () => {
    let total = 0;
    const deps: DiagnoseDeps = {
      diagnose: async () => {
        throw new Error("401 unauthorized");
      },
      canSpend: () => true,
      addSpend: (c) => (total += c),
      limit: 3,
    };
    const [p] = await diagnoseConfirmed(deps, [incident("a")]);
    expect(p!.error).toContain("401");
    expect(p!.actions).toEqual([]);
    expect(total).toBe(0);
  });

  it("skips incidents as noBudget once the spend cap is reached, leaving later ones un-diagnosed", async () => {
    let budget = true;
    const deps: DiagnoseDeps = {
      diagnose: async (i) => {
        budget = false; // first call exhausts the budget
        return { analysis: i.name, actions: [], costUsd: 1 };
      },
      canSpend: () => budget,
      addSpend: () => {},
      limit: 1, // serial so the cap deterministically trips after the first
    };
    const packets = await diagnoseConfirmed(deps, ["a", "b", "c"].map(incident));
    expect(packets[0]!.noBudget).toBeUndefined();
    expect(packets[1]!.noBudget).toBe(true);
    expect(packets[2]!.noBudget).toBe(true);
  });
});
