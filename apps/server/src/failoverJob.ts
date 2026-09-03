import { randomUUID } from "node:crypto";
import type { FailoverJob, FailoverSelection, FailoverStep } from "@rigel/k8s/src/failover/types";
import { runFailover, type FailoverRunResult } from "./failoverRun";

/**
 * A failover run outlives any one HTTP request: provisioning, installing the
 * stack, dumping and restoring takes many minutes. The request starts a job and
 * returns; the panel reads the steps back until it finishes.
 *
 * One job at a time, in this process. A failover is not something you run twice
 * at once, and a second run would fight the first over the same destination.
 */
let current: FailoverJob | null = null;
let running: Promise<void> | null = null;

/** The steps the Running screen shows before anything has reported in. */
export function plannedSteps(): FailoverStep[] {
  return [
    { id: "provision", label: "Provision DOKS", status: "pending" },
    { id: "stack", label: "Install stack", status: "pending" },
    { id: "rewrite", label: "Rewrite endpoints", status: "pending" },
    { id: "apply", label: "Apply closure", status: "pending" },
    { id: "loadBalancer", label: "Read load balancer", status: "pending" },
  ];
}

/** Replaces a step in place by id, or appends one the plan did not know about. */
export function mergeStep(steps: FailoverStep[], next: FailoverStep): FailoverStep[] {
  const at = steps.findIndex((s) => s.id === next.id);
  if (at === -1) return [...steps, next];
  const copy = [...steps];
  copy[at] = next;
  return copy;
}

export function readFailoverJob(): FailoverJob | null {
  return current;
}

export function failoverJobIsRunning(): boolean {
  return current?.status === "running";
}

/** Test seam: forget the job so each case starts clean. */
export function __resetFailoverJob(): void {
  current = null;
  running = null;
}

/** Test seam: await the in-flight run without exposing the promise to callers. */
export function __awaitFailoverJob(): Promise<void> {
  return running ?? Promise.resolve();
}

export function startFailoverJob(
  context: string | null,
  selection: FailoverSelection,
  acceptedRewrites: Array<{ rule: string; to: unknown }> = [],
  run: typeof runFailover = runFailover,
): FailoverJob {
  if (current?.status === "running") {
    const err = new Error("A failover is already running") as Error & { status: number };
    err.status = 409;
    throw err;
  }

  const job: FailoverJob = {
    id: randomUUID(),
    context,
    startedAt: new Date().toISOString(),
    status: "running",
    steps: plannedSteps(),
  };
  current = job;

  running = run(context, selection, acceptedRewrites, {
    report: (step) => {
      job.steps = mergeStep(job.steps, step);
    },
  })
    .then((result: FailoverRunResult) => {
      job.status = "done";
      job.result = {
        context: result.context,
        lbAddress: result.lbAddress,
        edgeChange: result.edgeChange,
        batchId: result.batchId,
        members: result.members,
        data: result.data,
      };
    })
    .catch((err: unknown) => {
      job.status = "failed";
      job.error = (err as Error)?.message ?? String(err);
      const blockers = (err as { blockers?: unknown }).blockers;
      if (blockers) (job as FailoverJob & { blockers?: unknown }).blockers = blockers;
      job.steps = job.steps.map((s) =>
        s.status === "running" ? { ...s, status: "failed", error: job.error } : s,
      );
    })
    .finally(() => {
      job.endedAt = new Date().toISOString();
    });

  return job;
}
