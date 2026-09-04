import { randomUUID } from "node:crypto";
import type { FailoverJob, FailoverSelection, FailoverStep } from "@rigel/k8s/src/failover/types";
import {
  parseFailoverJob,
  reviveFailoverJob,
  serializeFailoverJob,
} from "@rigel/k8s/src/failover/state";
import { FAILOVER_JOB_KEY } from "@rigel/k8s/src/userConfig";
import { readUserConfig, writeUserConfig } from "./clusterConfigStore";
import { restoreHome, runFailover, type FailoverRunResult } from "./failoverRun";

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

/** The steps a restore shows before anything has reported in. */
export function plannedRestoreSteps(): FailoverStep[] {
  return [
    { id: "scaleRemote", label: "Scale remote writers to zero", status: "pending" },
    { id: "scaleHome", label: "Scale home replicas back", status: "pending" },
    { id: "destroy", label: "Destroy the DOKS cluster", status: "pending" },
  ];
}

/** The steps the Running screen shows before anything has reported in. */
export function plannedSteps(hasObjectStore = false): FailoverStep[] {
  return [
    { id: "provision", label: "Provision DOKS", status: "pending" },
    { id: "stack", label: "Install stack", status: "pending" },
    { id: "rewrite", label: "Rewrite endpoints", status: "pending" },
    { id: "apply", label: "Apply closure", status: "pending" },
    { id: "loadBalancer", label: "Read load balancer", status: "pending" },
    ...(hasObjectStore
      ? [{ id: "upload", label: "Upload dumps to object store", status: "pending" as const }]
      : []),
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

/**
 * The job in this process if there is one, otherwise the last one written to the
 * cluster. A restart mid-run leaves a real DOKS cluster behind, so the panel has
 * to be able to see the run it lost.
 */
export async function loadFailoverJob(context: string | null): Promise<FailoverJob | null> {
  if (current) return current;
  const read = await readUserConfig(context).catch(() => null);
  return reviveFailoverJob(parseFailoverJob(read?.data?.[FAILOVER_JOB_KEY] ?? ""));
}

/** Serialised through writeUserConfig's queue; a later write wins. */
function persist(job: FailoverJob, save: PersistFn): void {
  save(job.context, () => ({ [FAILOVER_JOB_KEY]: serializeFailoverJob(job) })).catch(() => {
    /* a run that cannot write its own progress must still finish running */
  });
}

export type PersistFn = typeof writeUserConfig;

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
  save: PersistFn = writeUserConfig,
  hasObjectStore = false,
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
    steps: plannedSteps(hasObjectStore),
  };
  current = job;
  persist(job, save);

  running = run(context, selection, acceptedRewrites, {
    report: (step) => {
      job.steps = mergeStep(job.steps, step);
      persist(job, save);
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
      const provisioned = (err as { provisioned?: unknown }).provisioned;
      if (provisioned) (job as FailoverJob & { provisioned?: unknown }).provisioned = provisioned;
      job.steps = job.steps.map((s) =>
        s.status === "running" ? { ...s, status: "failed", error: job.error } : s,
      );
    })
    .finally(() => {
      job.endedAt = new Date().toISOString();
      persist(job, save);
    });

  return job;
}

/** A restore is the same shape of long job: many minutes, reported as steps. */
export function startRestoreJob(
  context: string | null,
  opts: { localWriteAt?: string } = {},
  restore: typeof restoreHome = restoreHome,
  save: PersistFn = writeUserConfig,
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
    steps: plannedRestoreSteps(),
  };
  current = job;
  persist(job, save);

  running = restore(context, opts, {
    report: (step) => {
      job.steps = mergeStep(job.steps, step);
      persist(job, save);
    },
  })
    .then((out) => {
      if (!out.ok) {
        job.status = "failed";
        job.error = out.error;
        return;
      }
      job.status = "done";
      job.result = out;
    })
    .catch((err: unknown) => {
      job.status = "failed";
      job.error = (err as Error)?.message ?? String(err);
      job.steps = job.steps.map((s) =>
        s.status === "running" ? { ...s, status: "failed", error: job.error } : s,
      );
    })
    .finally(() => {
      job.endedAt = new Date().toISOString();
      persist(job, save);
    });

  return job;
}
