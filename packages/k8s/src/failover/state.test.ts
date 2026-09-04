import { describe, expect, it } from "vitest";
import {
  isFailoverActive,
  parseFailoverJob,
  parseFailoverState,
  reviveFailoverJob,
  serializeFailoverJob,
  serializeFailoverState,
} from "./state";

describe("failover state round trip", () => {
  it("survives a round trip and treats junk as empty", () => {
    const state = { failedOverTo: { context: "do-tor1-x", at: "2026-09-03T01:00:00.000Z", batchId: "b1", scaledToZero: [], edgeConfirmed: false } };
    expect(parseFailoverState(serializeFailoverState(state))).toEqual(state);
    expect(parseFailoverState("")).toEqual({});
    expect(parseFailoverState("{not json")).toEqual({});
  });

  it("knows when a failover is active", () => {
    expect(isFailoverActive({})).toBe(false);
    expect(isFailoverActive({ failoverCopyOf: { context: "home", batchId: "b1" } })).toBe(true);
  });
});

describe("failover job round trip", () => {
  const job = {
    id: "j1",
    context: "home",
    startedAt: "2026-09-03T01:00:00.000Z",
    status: "running" as const,
    steps: [
      { id: "provision", label: "Provision DOKS", status: "done" as const },
      { id: "apply", label: "Apply closure", status: "running" as const },
    ],
  };

  it("survives a round trip", () => {
    expect(parseFailoverJob(serializeFailoverJob(job))).toEqual(job);
  });

  it("treats junk and an empty blob as no job", () => {
    expect(parseFailoverJob("")).toBeNull();
    expect(parseFailoverJob("{not json")).toBeNull();
    expect(parseFailoverJob('{"id":"x"}')).toBeNull();
  });
});

describe("reviveFailoverJob", () => {
  it("fails a job that was still running when the process died", () => {
    const revived = reviveFailoverJob({
      id: "j1",
      context: "home",
      startedAt: "2026-09-03T01:00:00.000Z",
      status: "running",
      steps: [
        { id: "provision", label: "Provision DOKS", status: "done" },
        { id: "apply", label: "Apply closure", status: "running" },
      ],
    });
    expect(revived?.status).toBe("failed");
    expect(revived?.error).toMatch(/restarted while this run was in flight/i);
    expect(revived?.steps.find((s) => s.id === "apply")?.status).toBe("failed");
    expect(revived?.steps.find((s) => s.id === "provision")?.status).toBe("done");
  });

  it("leaves a finished job alone", () => {
    const done = {
      id: "j1",
      context: "home",
      startedAt: "2026-09-03T01:00:00.000Z",
      status: "done" as const,
      steps: [{ id: "apply", label: "Apply closure", status: "done" as const }],
    };
    expect(reviveFailoverJob(done)).toEqual(done);
  });

  it("passes null through", () => {
    expect(reviveFailoverJob(null)).toBeNull();
  });
});
