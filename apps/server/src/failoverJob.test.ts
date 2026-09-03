import { afterEach, describe, expect, it, vi } from "vitest";
import type { FailoverStep } from "@rigel/k8s/src/failover/types";
import {
  __awaitFailoverJob,
  __resetFailoverJob,
  failoverJobIsRunning,
  mergeStep,
  plannedSteps,
  readFailoverJob,
  startFailoverJob,
} from "./failoverJob";

const selection = { kind: "namespace" as const, namespace: "default" };

const result = {
  context: "do-tor1-x",
  lbAddress: "147.182.11.40",
  edgeChange: { host: "e", backends: [], replaceWith: "147.182.11.40", snippet: "s", revertSnippet: "r" },
  batchId: "b1",
  members: [],
  data: { steps: [] },
};

afterEach(() => {
  __resetFailoverJob();
});

describe("mergeStep", () => {
  it("replaces a step in place rather than appending a duplicate", () => {
    const steps: FailoverStep[] = [{ id: "apply", label: "Apply closure", status: "pending" }];
    const merged = mergeStep(steps, { id: "apply", label: "Apply closure", status: "done" });
    expect(merged).toHaveLength(1);
    expect(merged[0]?.status).toBe("done");
  });

  it("appends a step the plan did not know about", () => {
    const merged = mergeStep(plannedSteps(), { id: "data:default/postgres", label: "Dump", status: "running" });
    expect(merged).toHaveLength(plannedSteps().length + 1);
    expect(merged.at(-1)?.id).toBe("data:default/postgres");
  });
});

describe("startFailoverJob", () => {
  it("returns immediately with pending steps rather than waiting for the run", async () => {
    let finish: (v: typeof result) => void = () => {};
    const run = vi.fn(() => new Promise<typeof result>((res) => { finish = res; }));
    const job = startFailoverJob(null, selection, [], run as never);

    expect(job.status).toBe("running");
    expect(job.steps.every((s) => s.status === "pending")).toBe(true);
    expect(failoverJobIsRunning()).toBe(true);

    finish(result);
    await __awaitFailoverJob();
    expect(readFailoverJob()?.status).toBe("done");
  });

  it("records reported steps as the run makes progress", async () => {
    const run = vi.fn(async (_c, _s, _r, deps: { report: (s: FailoverStep) => void }) => {
      deps.report({ id: "provision", label: "Provision DOKS", status: "running" });
      deps.report({ id: "provision", label: "Provision DOKS", status: "done", detail: "do-tor1-x" });
      deps.report({ id: "data:default/postgres", label: "Dump and restore Postgres", status: "done" });
      return result;
    });
    startFailoverJob(null, selection, [], run as never);
    await __awaitFailoverJob();

    const steps = readFailoverJob()!.steps;
    expect(steps.find((s) => s.id === "provision")).toMatchObject({ status: "done", detail: "do-tor1-x" });
    expect(steps.find((s) => s.id === "data:default/postgres")?.status).toBe("done");
    expect(steps.filter((s) => s.id === "provision")).toHaveLength(1);
  });

  it("keeps the result without any dump bytes", async () => {
    const run = vi.fn(async () => result);
    startFailoverJob(null, selection, [], run as never);
    await __awaitFailoverJob();
    expect(readFailoverJob()?.result).toMatchObject({ lbAddress: "147.182.11.40", batchId: "b1" });
  });

  it("marks the job failed and fails whatever step was mid-flight", async () => {
    const run = vi.fn(async (_c, _s, _r, deps: { report: (s: FailoverStep) => void }) => {
      deps.report({ id: "apply", label: "Apply closure", status: "running" });
      throw new Error("apply rejected the bundle");
    });
    startFailoverJob(null, selection, [], run as never);
    await __awaitFailoverJob();

    const job = readFailoverJob()!;
    expect(job.status).toBe("failed");
    expect(job.error).toBe("apply rejected the bundle");
    expect(job.steps.find((s) => s.id === "apply")).toMatchObject({ status: "failed" });
    expect(job.endedAt).toBeTruthy();
  });

  it("carries blockers through so the panel can show them", async () => {
    const run = vi.fn(async () => {
      const err = new Error("Failover is blocked until findings are accepted") as Error & { blockers: unknown };
      err.blockers = [{ rule: "storageClassMissing" }];
      throw err;
    });
    startFailoverJob(null, selection, [], run as never);
    await __awaitFailoverJob();
    expect((readFailoverJob() as { blockers?: unknown }).blockers).toEqual([{ rule: "storageClassMissing" }]);
  });

  it("refuses a second run while one is in flight", async () => {
    let finish: (v: typeof result) => void = () => {};
    const run = vi.fn(() => new Promise<typeof result>((res) => { finish = res; }));
    startFailoverJob(null, selection, [], run as never);

    expect(() => startFailoverJob(null, selection, [], run as never)).toThrow(/already running/);
    expect(run).toHaveBeenCalledTimes(1);

    finish(result);
    await __awaitFailoverJob();
  });

  it("allows a new run once the previous one finished", async () => {
    const run = vi.fn(async () => result);
    const first = startFailoverJob(null, selection, [], run as never);
    await __awaitFailoverJob();
    const second = startFailoverJob(null, selection, [], run as never);
    await __awaitFailoverJob();
    expect(second.id).not.toBe(first.id);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
