import { describe, expect, test, vi } from "vitest";
import { runThreadedDiagnosis, type ThreadedDiagnosisDeps } from "./threadedDiagnosis.js";
import { SessionStore } from "./sessionStore.js";
import type { DiagnosisOutput } from "./diagnose.js";

const SOURCE = "+15550101234";
const T0 = 1_000_000; // arbitrary base timestamp
const WITHIN_HOUR = T0 + 1_000; // well within the 1-hour TTL

function fakeOutput(text: string, costUsd = 0.05, sessionId = "sess-abc"): DiagnosisOutput {
  return { text, costUsd, sessionId };
}

describe("runThreadedDiagnosis", () => {
  test("spend cap: returns cap message immediately, diagnose never called", async () => {
    const diagnose = vi.fn(async () => fakeOutput("all good"));
    const addSpend = vi.fn();
    const deps: ThreadedDiagnosisDeps = {
      sessions: new SessionStore(),
      diagnose,
      canSpend: () => false,
      addSpend,
    };
    const result = await runThreadedDiagnosis(deps, SOURCE, T0, "is anything broken?");
    expect(result).toBe("I've reached my monthly spend cap, so I can't investigate right now.");
    expect(diagnose).not.toHaveBeenCalled();
    expect(addSpend).not.toHaveBeenCalled();
  });

  test("fresh success (no prior session): diagnose called once with (question, undefined)", async () => {
    const sessions = new SessionStore();
    const diagnose = vi.fn(async () => fakeOutput("pods look healthy", 0.03, "sess-new"));
    const addSpend = vi.fn();
    const deps: ThreadedDiagnosisDeps = {
      sessions,
      diagnose,
      canSpend: () => true,
      addSpend,
    };
    const result = await runThreadedDiagnosis(deps, SOURCE, T0, "why is foo slow?");
    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(diagnose).toHaveBeenCalledWith("why is foo slow?", undefined);
    expect(result).toBe("pods look healthy");
    expect(addSpend).toHaveBeenCalledTimes(1);
    expect(addSpend).toHaveBeenCalledWith(0.03);
    // session should now be recorded so a follow-up within the hour resumes it
    expect(sessions.resumeIdFor(SOURCE, WITHIN_HOUR)).toBe("sess-new");
  });

  test("resume success: pre-recorded session is passed to diagnose", async () => {
    const sessions = new SessionStore();
    sessions.record(SOURCE, "sess-prior", T0);
    const diagnose = vi.fn(async () => fakeOutput("still healthy", 0.02, "sess-next"));
    const addSpend = vi.fn();
    const deps: ThreadedDiagnosisDeps = {
      sessions,
      diagnose,
      canSpend: () => true,
      addSpend,
    };
    const result = await runThreadedDiagnosis(deps, SOURCE, WITHIN_HOUR, "any updates?");
    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(diagnose).toHaveBeenCalledWith("any updates?", "sess-prior");
    expect(result).toBe("still healthy");
    expect(addSpend).toHaveBeenCalledWith(0.02);
    // new session id is recorded for the next message
    expect(sessions.resumeIdFor(SOURCE, WITHIN_HOUR + 1)).toBe("sess-next");
  });

  test("stale resume → self-heal: first call rejects, second call succeeds fresh", async () => {
    const sessions = new SessionStore();
    sessions.record(SOURCE, "sess-stale", T0);
    const logFn = vi.fn();
    let callCount = 0;
    const diagnose = vi.fn(async (_q: string, _resumeId?: string) => {
      callCount++;
      if (callCount === 1) throw new Error("session not found");
      return fakeOutput("recovered answer", 0.04, "sess-fresh");
    });
    const addSpend = vi.fn();
    const deps: ThreadedDiagnosisDeps = {
      sessions,
      diagnose,
      canSpend: () => true,
      addSpend,
      log: logFn,
    };
    const result = await runThreadedDiagnosis(deps, SOURCE, WITHIN_HOUR, "what happened?");
    // diagnose called twice: first with stale id, second with undefined
    expect(diagnose).toHaveBeenCalledTimes(2);
    expect(diagnose).toHaveBeenNthCalledWith(1, "what happened?", "sess-stale");
    // retry call has no resumeId argument (called as diagnose(question))
    expect(diagnose).toHaveBeenNthCalledWith(2, "what happened?");
    // addSpend called exactly once with the successful call's cost
    expect(addSpend).toHaveBeenCalledTimes(1);
    expect(addSpend).toHaveBeenCalledWith(0.04);
    // new session id is recorded
    expect(sessions.resumeIdFor(SOURCE, WITHIN_HOUR + 1)).toBe("sess-fresh");
    // log was called to report the stale resume
    expect(logFn).toHaveBeenCalledWith(expect.stringContaining("resume failed"));
    expect(result).toBe("recovered answer");
  });

  test("fresh failure propagates: no prior session, diagnose rejects → runThreadedDiagnosis rejects", async () => {
    const addSpend = vi.fn();
    const sessions = new SessionStore();
    const diagnose = vi.fn(async () => {
      throw new Error("model unavailable");
    });
    const deps: ThreadedDiagnosisDeps = {
      sessions,
      diagnose,
      canSpend: () => true,
      addSpend,
    };
    await expect(
      runThreadedDiagnosis(deps, SOURCE, T0, "anything wrong?"),
    ).rejects.toThrow("model unavailable");
    expect(addSpend).not.toHaveBeenCalled();
    // nothing recorded
    expect(sessions.resumeIdFor(SOURCE, WITHIN_HOUR)).toBeUndefined();
  });

  test("empty text from model returns fallback message", async () => {
    const addSpend = vi.fn();
    const deps: ThreadedDiagnosisDeps = {
      sessions: new SessionStore(),
      diagnose: vi.fn(async () => fakeOutput("", 0.01, "sess-empty")),
      canSpend: () => true,
      addSpend,
    };
    const result = await runThreadedDiagnosis(deps, SOURCE, T0, "is it quiet?");
    expect(result).toBe("I couldn't find anything conclusive — try asking more specifically.");
    expect(addSpend).toHaveBeenCalledWith(0.01);
  });
});
