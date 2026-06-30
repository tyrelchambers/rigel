import { describe, expect, test, vi } from "vitest";
import { reconcileFixJobs, type FixReconcileDeps } from "./reconcileFixJobs.js";
import { FIX_ANNOTATION, type FixMeta as Meta } from "./fixJob.js";
import { appendAudit, emptyState, type AssistantState, type QueuedSuggestion } from "./state.js";

const FP = "unhealthyPod|default|memos-7d9f-abc|CrashLoopBackOff";
const FILE = "apps/memos/deployment.yaml";
const TITLE = "Bump memos image to a healthy tag";
const INCIDENT = "default/memos-7d9f-abc: CrashLoopBackOff";

const META: Meta = {
  fingerprint: FP,
  filePath: FILE,
  incident: INCIDENT,
  repoURL: "https://github.com/me/infra",
  branch: "main",
  source: "memos",
  title: TITLE,
};

const JOB_NAME = "rigel-fix-memos-7d9f-abc123";

/** A finished Job manifest stamped with the fix provenance annotations. */
function job(over: { name?: string; status?: Record<string, unknown>; meta?: Partial<Meta> } = {}): Record<string, unknown> {
  const m = { ...META, ...over.meta };
  return {
    metadata: {
      name: over.name ?? JOB_NAME,
      annotations: {
        [FIX_ANNOTATION.fingerprint]: m.fingerprint,
        [FIX_ANNOTATION.filePath]: m.filePath,
        [FIX_ANNOTATION.incident]: m.incident,
        [FIX_ANNOTATION.repoURL]: m.repoURL,
        [FIX_ANNOTATION.branch]: m.branch,
        [FIX_ANNOTATION.source]: m.source,
        [FIX_ANNOTATION.title]: m.title,
      },
    },
    status: over.status ?? { succeeded: 1 },
  };
}

function deps(over: Partial<FixReconcileDeps> = {}): FixReconcileDeps {
  return {
    listFixJobs: async () => [job()],
    readTerminationMessage: async () => JSON.stringify({ ok: true, prUrl: "https://github.com/me/infra/pull/7", branch: "rigel/fix-memos" }),
    ...over,
  };
}

const ctx = { at: "2026-06-30T12:00:00.000Z", auditMaxEntries: 200 };

describe("reconcileFixJobs", () => {
  test("a succeeded Job records an opened PR, notifies once, and is queued for GC", async () => {
    const r = await reconcileFixJobs(deps(), emptyState(), ctx);
    expect(r.state.pullRequests).toHaveLength(1);
    expect(r.state.pullRequests![0]).toMatchObject({
      status: "open", prUrl: "https://github.com/me/infra/pull/7", branch: "rigel/fix-memos",
      app: "memos", repo: "https://github.com/me/infra", title: TITLE, fingerprint: FP, filePath: FILE, kind: "config",
    });
    expect(r.notifications).toHaveLength(1);
    expect(r.notifications[0]).toBe(`Rigel opened a PR for memos: ${TITLE} (https://github.com/me/infra/pull/7)`);
    expect(r.gc).toEqual([JOB_NAME]);
    // The terminal audit entry was recorded.
    expect(r.state.audit[0]).toMatchObject({ outcome: "success", proposal: TITLE, fingerprint: FP });
    expect(r.state.audit[0]?.detail).toContain("pull/7");
  });

  test("replaces the dispatch's PENDING audit entry in place (not a new entry)", async () => {
    // Seed the pending fix-PR audit entry the dispatch records (queued, no verdict).
    const seeded = appendAudit(emptyState(), {
      at: "2026-06-30T11:00:00.000Z", fingerprint: FP, incident: INCIDENT, proposal: TITLE,
      tier: "medium", outcome: "queued", detail: "fix PR opening (pending the fix-runner): ...",
    }, 200);
    const r = await reconcileFixJobs(deps(), seeded, ctx);
    // Still exactly one audit entry — the pending one was REPLACED with the terminal.
    expect(r.state.audit).toHaveLength(1);
    expect(r.state.audit[0]).toMatchObject({ outcome: "success", proposal: TITLE });
  });

  test("drops the matching 'fix PR pending' queue item once resolved", async () => {
    const queued: QueuedSuggestion = {
      at: "2026-06-30T11:00:00.000Z", fingerprint: FP, incident: INCIDENT, suggestion: TITLE,
      reason: "fix PR pending the fix-runner", action: { label: TITLE, kind: "openFixPR" },
    };
    const seeded: AssistantState = { ...emptyState(), queue: [queued] };
    const r = await reconcileFixJobs(deps(), seeded, ctx);
    expect(r.state.queue).toHaveLength(0);
  });

  test("idempotent: a Job reconciled again before its GC produces NO duplicate record/notification", async () => {
    const first = await reconcileFixJobs(deps(), emptyState(), ctx);
    const second = await reconcileFixJobs(deps(), first.state, ctx);
    expect(second.state.pullRequests).toHaveLength(1); // not 2
    expect(second.notifications).toHaveLength(0); // not re-notified
    expect(second.gc).toEqual([JOB_NAME]); // still GC'd (retry a failed prior delete)
    // The audit didn't grow either (already terminal; nothing to replace/append).
    expect(second.state.audit).toHaveLength(first.state.audit.length);
  });

  test("a malformed termination message → a failure record, no crash, no notification", async () => {
    const r = await reconcileFixJobs(deps({ readTerminationMessage: async () => "not json at all" }), emptyState(), ctx);
    expect(r.state.pullRequests![0]).toMatchObject({ status: "failed", prUrl: undefined });
    expect(r.state.pullRequests![0]?.summary).toMatch(/malformed/);
    expect(r.notifications).toHaveLength(0);
    expect(r.state.audit[0]).toMatchObject({ outcome: "failure" });
    expect(r.gc).toEqual([JOB_NAME]);
  });

  test("an empty/absent termination message → a failure record, no crash", async () => {
    const r1 = await reconcileFixJobs(deps({ readTerminationMessage: async () => "" }), emptyState(), ctx);
    expect(r1.state.pullRequests![0]).toMatchObject({ status: "failed" });
    const r2 = await reconcileFixJobs(deps({ readTerminationMessage: async () => null }), emptyState(), ctx);
    expect(r2.state.pullRequests![0]).toMatchObject({ status: "failed" });
    expect(r1.notifications).toHaveLength(0);
    expect(r2.notifications).toHaveLength(0);
  });

  test("a failed Job (ok:false with a message) is recorded as failed, no PR url, no notification", async () => {
    const r = await reconcileFixJobs(
      deps({ readTerminationMessage: async () => JSON.stringify({ ok: false, message: "git push rejected" }) }),
      emptyState(), ctx,
    );
    expect(r.state.pullRequests![0]).toMatchObject({ status: "failed", prUrl: undefined, summary: "git push rejected" });
    expect(r.state.audit[0]).toMatchObject({ outcome: "failure" });
    expect(r.state.audit[0]?.detail).toMatch(/git push rejected/);
    expect(r.notifications).toHaveLength(0);
    expect(r.gc).toEqual([JOB_NAME]);
  });

  test("ok:true but no prUrl is treated as a failure (never a phantom 'open' PR)", async () => {
    const r = await reconcileFixJobs(
      deps({ readTerminationMessage: async () => JSON.stringify({ ok: true }) }),
      emptyState(), ctx,
    );
    expect(r.state.pullRequests![0]).toMatchObject({ status: "failed", prUrl: undefined });
    expect(r.notifications).toHaveLength(0);
  });

  test("a still-running Job is skipped entirely (no record, no GC, no term-message read)", async () => {
    const read = vi.fn();
    const r = await reconcileFixJobs(
      deps({ listFixJobs: async () => [job({ status: { active: 1 } })], readTerminationMessage: read }),
      emptyState(), ctx,
    );
    expect(read).not.toHaveBeenCalled();
    expect(r.state.pullRequests ?? []).toHaveLength(0);
    expect(r.gc).toHaveLength(0);
  });

  test("completes via a terminal condition even without succeeded/failed counts", async () => {
    const r = await reconcileFixJobs(
      deps({ listFixJobs: async () => [job({ status: { conditions: [{ type: "Failed", status: "True" }] } })],
             readTerminationMessage: async () => JSON.stringify({ ok: false, message: "boom" }) }),
      emptyState(), ctx,
    );
    expect(r.state.pullRequests![0]).toMatchObject({ status: "failed" });
    expect(r.gc).toEqual([JOB_NAME]);
  });

  test("two distinct completed fixes are each recorded; one notification per opened PR", async () => {
    const other = job({
      name: "rigel-fix-other-def456",
      meta: { fingerprint: "unhealthyPod|default|api|CrashLoopBackOff", filePath: "apps/api/deployment.yaml", source: "api", title: "Fix api", incident: "default/api: CrashLoopBackOff" },
    });
    const r = await reconcileFixJobs(
      deps({
        listFixJobs: async () => [job(), other],
        readTerminationMessage: async (name) =>
          name === JOB_NAME
            ? JSON.stringify({ ok: true, prUrl: "https://github.com/me/infra/pull/7" })
            : JSON.stringify({ ok: false, message: "failed" }),
      }),
      emptyState(), ctx,
    );
    expect(r.state.pullRequests).toHaveLength(2);
    expect(r.notifications).toHaveLength(1); // only the opened one notifies
    expect(r.gc).toEqual([JOB_NAME, "rigel-fix-other-def456"]);
  });

  test("never throws, even when listFixJobs rejects", async () => {
    const r = await reconcileFixJobs(deps({ listFixJobs: async () => { throw new Error("boom"); } }), emptyState(), ctx);
    expect(r).toEqual({ state: emptyState(), notifications: [], gc: [] });
  });

  test("a single bad Job (term read throws) is skipped (failure recorded) without aborting the rest", async () => {
    // The term-read throws → caught inside (msg=null) → recorded as a failure, not a crash.
    const r = await reconcileFixJobs(
      deps({ readTerminationMessage: async () => { throw new Error("kubectl exploded"); } }),
      emptyState(), ctx,
    );
    expect(r.state.pullRequests![0]).toMatchObject({ status: "failed" });
    expect(r.gc).toEqual([JOB_NAME]);
  });

  test("no fix Jobs → a no-op (state unchanged, nothing to GC)", async () => {
    const r = await reconcileFixJobs(deps({ listFixJobs: async () => [] }), emptyState(), ctx);
    expect(r.state).toEqual(emptyState());
    expect(r.notifications).toHaveLength(0);
    expect(r.gc).toHaveLength(0);
  });
});
