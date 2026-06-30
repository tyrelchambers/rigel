import { readFixMeta } from "./fixJob.js";
import {
  recordPullRequest,
  resolveFixAudit,
  type AssistantState,
  type AuditEntry,
  type PullRequestRecord,
} from "./state.js";

/**
 * The Phase-4 loop close: read the result of each FINISHED `rigel-fix-<id>` Job
 * back off its pod's container termination message, record the opened PR (or the
 * failure) into the agent's state, replace the dispatch's pending audit entry with
 * the terminal outcome, and return the operator notification(s) + the resource
 * names to GC.
 *
 * NO IO lives here — the cluster touches are the injected `deps` (so it is
 * unit-testable). It is IDEMPOTENT: recording dedups on the fix's
 * fingerprint+filePath, so a Job seen again before its GC produces NO duplicate
 * record/notification (but is still returned for GC, so a previously-failed delete
 * is retried). The caller GCs `result.gc` AFTER durably writing `result.state`, so
 * a crash between recording and deletion re-processes the Job (dedup-safe) rather
 * than losing an opened PR. A malformed/empty termination message is treated as a
 * failure, never a crash; one bad Job never aborts the rest.
 */
export interface FixReconcileDeps {
  /** The fix Jobs (label-selected) in the state namespace, as parsed JSON items, or
   *  `null` when the list could NOT be read (non-zero exit / spawn throw) so callers
   *  can tell "unreadable" apart from "genuinely empty". */
  listFixJobs: () => Promise<unknown[] | null>;
  /** The Job's pod container termination message (the runner's result JSON), or
   *  null when unavailable. */
  readTerminationMessage: (jobName: string) => Promise<string | null>;
}

export interface FixReconcileContext {
  /** Reconcile timestamp (ISO), stamped on the record + audit entry. */
  at: string;
  auditMaxEntries: number;
  pullRequestsMax?: number;
}

export interface FixReconcileResult {
  state: AssistantState;
  /** One line per NEWLY-opened PR, for this tick's outbound notifications. */
  notifications: string[];
  /** Resource names (the Job == its ConfigMap name) to delete AFTER the state
   *  write — includes already-recorded Jobs so a failed prior GC is retried. */
  gc: string[];
}

/** The fix-runner's result, as written to the pod termination message. */
interface RunResult {
  ok: boolean;
  prUrl?: string;
  branch?: string;
  message?: string;
}

/** Parse the termination message, guarding malformed/empty input as a failure. */
function parseResult(raw: string | null): RunResult {
  if (!raw || raw.trim() === "") return { ok: false, message: "the fix-runner reported no result" };
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { ok: false, message: `malformed fix-runner result: ${raw.slice(0, 200)}` };
  }
  if (!obj || typeof obj !== "object") return { ok: false, message: "malformed fix-runner result (not an object)" };
  const o = obj as Record<string, unknown>;
  return {
    ok: o.ok === true,
    prUrl: typeof o.prUrl === "string" ? o.prUrl : undefined,
    branch: typeof o.branch === "string" ? o.branch : undefined,
    message: typeof o.message === "string" ? o.message : undefined,
  };
}

function jobName(job: Record<string, unknown>): string {
  return (job.metadata as { name?: string } | undefined)?.name ?? "";
}

function jobAnnotations(job: Record<string, unknown>): Record<string, string> {
  return (job.metadata as { annotations?: Record<string, string> } | undefined)?.annotations ?? {};
}

/** A Job is finished once it has a succeeded/failed count or a terminal condition.
 *  With backoffLimit 0 + restartPolicy Never that is exactly one attempt. */
function isComplete(job: Record<string, unknown>): boolean {
  const status = (job.status ?? {}) as {
    succeeded?: number;
    failed?: number;
    conditions?: { type?: string; status?: string }[];
  };
  if ((status.succeeded ?? 0) > 0 || (status.failed ?? 0) > 0) return true;
  return (status.conditions ?? []).some(
    (c) => (c.type === "Complete" || c.type === "Failed") && c.status === "True",
  );
}

export async function reconcileFixJobs(
  deps: FixReconcileDeps,
  state: AssistantState,
  ctx: FixReconcileContext,
): Promise<FixReconcileResult> {
  const notifications: string[] = [];
  const gc: string[] = [];

  let jobs: unknown[] | null;
  try {
    jobs = await deps.listFixJobs();
  } catch {
    return { state, notifications, gc };
  }
  // Unreadable list (null) → nothing to reconcile this tick (same as a throw); an
  // empty array is a genuine "no jobs" and falls straight through the loop.
  if (!jobs) return { state, notifications, gc };

  for (const raw of jobs) {
    if (!raw || typeof raw !== "object") continue;
    const job = raw as Record<string, unknown>;
    const name = jobName(job);
    if (!name || !isComplete(job)) continue; // not ours / still running → leave it

    try {
      const meta = readFixMeta(jobAnnotations(job));
      let msg: string | null;
      try {
        msg = await deps.readTerminationMessage(name);
      } catch {
        msg = null;
      }
      const result = parseResult(msg);
      const opened = result.ok && !!result.prUrl;
      const title = meta.title || meta.incident;

      const record: PullRequestRecord = {
        at: ctx.at,
        fingerprint: meta.fingerprint,
        filePath: meta.filePath,
        incident: meta.incident,
        app: meta.source,
        repo: meta.repoURL,
        branch: result.branch || meta.branch || undefined,
        prUrl: opened ? result.prUrl : undefined,
        title,
        summary: result.message ?? "",
        status: opened ? "open" : "failed",
        kind: "config",
      };

      const rec = recordPullRequest(state, record, ctx.pullRequestsMax);
      // Always GC a completed Job we've processed (idempotent delete retries a
      // failed prior GC); only mutate audit/queue/notify when it was newly recorded.
      gc.push(name);
      if (!rec.added) continue;
      state = rec.state;

      const terminal: AuditEntry = opened
        ? {
            at: ctx.at, fingerprint: meta.fingerprint, incident: meta.incident, proposal: title,
            tier: "medium", outcome: "success", detail: `Rigel opened a fix PR: ${result.prUrl}`,
          }
        : {
            at: ctx.at, fingerprint: meta.fingerprint, incident: meta.incident, proposal: title,
            tier: "medium", outcome: "failure",
            detail: `fix PR could not be opened: ${result.message ?? "(no detail reported)"}`,
          };
      state = resolveFixAudit(state, meta.fingerprint, title, terminal, ctx.auditMaxEntries);

      // The dispatch surfaced a "fix PR pending" queue item for visibility; it is
      // resolved now → drop it so the queue doesn't show a stale pending fix.
      state = {
        ...state,
        queue: state.queue.filter(
          (q) => !(q.fingerprint === meta.fingerprint && q.suggestion === title && q.action?.kind === "openFixPR"),
        ),
      };

      if (opened) {
        notifications.push(`Rigel opened a PR for ${meta.source || "a workload"}: ${title} (${result.prUrl})`);
      }
    } catch {
      // A single bad Job must not abort the rest. Skip it (NO GC) so it is retried
      // next tick rather than deleted unrecorded.
      continue;
    }
  }

  return { state, notifications, gc };
}
