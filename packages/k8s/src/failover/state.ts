import type { FailoverJob, FailoverState } from "./types";

export function parseFailoverState(blob: string): FailoverState {
  if (!blob.trim()) return {};
  try {
    const parsed = JSON.parse(blob) as FailoverState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function serializeFailoverState(state: FailoverState): string {
  return JSON.stringify(state);
}

export function isFailoverActive(state: FailoverState): boolean {
  return !!state.failedOverTo || !!state.failoverCopyOf;
}

export function parseFailoverJob(blob: string): FailoverJob | null {
  if (!blob.trim()) return null;
  try {
    const parsed = JSON.parse(blob) as FailoverJob;
    return parsed && typeof parsed === "object" && Array.isArray(parsed.steps) ? parsed : null;
  } catch {
    return null;
  }
}

export function serializeFailoverJob(job: FailoverJob): string {
  return JSON.stringify(job);
}

/**
 * A job read back from the cluster that still says "running" cannot be: the run
 * lived in the process that wrote it. Say so rather than polling forever.
 */
export function reviveFailoverJob(job: FailoverJob | null): FailoverJob | null {
  if (!job || job.status !== "running") return job;
  return {
    ...job,
    status: "failed",
    error:
      "The app restarted while this run was in flight. Check the destination for a cluster that was left behind.",
    steps: job.steps.map((s) => (s.status === "running" ? { ...s, status: "failed" as const } : s)),
  };
}
