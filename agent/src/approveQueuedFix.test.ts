import { describe, expect, test, vi } from "vitest";
import { approveQueuedFix, consumeFixApprovals, type ApproveFixContext, type ApproveFixDeps } from "./approveQueuedFix.js";
import { CircuitBreaker } from "./guardrails.js";
import { emptyState, type AssistantState, type QueuedSuggestion } from "./state.js";
import type { KubectlResult } from "./kubectl.js";
import type { ResolvedRepo } from "./repoResolve.js";

const FP = "unhealthyPod|default|memos-abc|CrashLoopBackOff";
const REPO: ResolvedRepo = { source: "memos", repoURL: "https://github.com/me/infra", branch: "main", path: "apps/memos" };
const ACTION = {
  label: "Open fix PR", kind: "openFixPR", source: "memos", filePath: "apps/memos/deployment.yaml",
  content: "kind: Deployment\n...", title: "Bump memos image to a healthy tag", body: "The tag CrashLoops.",
};
const ITEM = {
  at: "2026-10-11T00:00:00.000Z", fingerprint: FP, incident: "default/memos-abc: CrashLoopBackOff",
  suggestion: ACTION.label, reason: "fix PR, set to Ask me in Action levels", action: ACTION,
} satisfies QueuedSuggestion;
const ok: KubectlResult = { stdout: "", stderr: "", code: 0 };

function deps(over: Partial<ApproveFixDeps> & { jobExists?: boolean } = {}) {
  const apply = vi.fn(async () => ok);
  const eligibility = vi.fn(async () => ({ inScope: true, repo: REPO }));
  const d: ApproveFixDeps = {
    repoFix: { jobExists: async () => over.jobExists ?? false, apply },
    listFixJobs: async () => [],
    eligibility,
    ...over,
  };
  return { d, apply, eligibility };
}

const cb = () => new CircuitBreaker({ maxPerResourcePerHour: 3, maxPerNight: 20, maxAttemptsPerIncident: 3, windowMs: 86_400_000 });
const ctx: ApproveFixContext = {
  at: "2026-10-11T01:00:00.000Z", nowMs: Date.parse("2026-10-11T01:00:00.000Z"), actor: "chat", tier: "ask",
  maxPerDay: 5, auditMaxEntries: 200, namespace: "rigel", image: "ghcr.io/me/rigel-assistant:abc",
};
const seeded = (): AssistantState => ({ ...emptyState(), queue: [ITEM] });

describe("approveQueuedFix", () => {
  test("dispatches the fix PR, swaps the approved item for the pending one, and audits the approval", async () => {
    const { d, apply, eligibility } = deps();
    const breaker = cb();
    const record = vi.spyOn(breaker, "record");
    const out = await approveQueuedFix(d, breaker, seeded(), ITEM, ctx);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(eligibility).toHaveBeenCalledWith(expect.objectContaining({ incidentKind: "unhealthyPod", namespace: "default", name: "memos-abc" }));
    expect(out.state.queue).toHaveLength(1);
    expect(out.state.queue[0]).toMatchObject({ reason: "fix PR pending the fix-runner", pending: true });
    expect(out.state.audit[0]).toMatchObject({ outcome: "queued", verdict: "approved", actor: "chat", tier: "ask" });
    expect(record).toHaveBeenCalledWith(FP, "default/memos", ctx.nowMs);
    expect(out.notification).toBe("▸ Fix PR pending: Bump memos image to a healthy tag (default/memos-abc: CrashLoopBackOff)");
    expect(out.reply).toBe("✓ Fix PR pending: Bump memos image to a healthy tag (default/memos-abc: CrashLoopBackOff)");
  });

  test("dispatches even when the breaker would veto an unattended fix", async () => {
    const { d, apply } = deps();
    const breaker = cb();
    for (let i = 0; i < 3; i++) breaker.record("x", "default/memos", ctx.nowMs);
    await approveQueuedFix(d, breaker, seeded(), ITEM, ctx);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  test("the daily budget still applies: nothing is created and the item stays queued", async () => {
    const { d, apply } = deps({ listFixJobs: async () => [{}, {}] });
    const out = await approveQueuedFix(d, cb(), seeded(), ITEM, { ...ctx, maxPerDay: 2 });
    expect(apply).not.toHaveBeenCalled();
    expect(out.state.queue).toEqual([ITEM]);
    expect(out.state.audit[0]).toMatchObject({ outcome: "skipped", verdict: "approved", detail: "daily fix-PR budget reached (2/2): not opening another fix PR until a slot frees up" });
    expect(out.reply).toMatch(/^✗ Couldn't open the fix PR: daily fix-PR budget reached/);
    expect(out.notification).toBeUndefined();
  });

  test("an unreadable in-flight list defers the approval", async () => {
    const { d, apply } = deps({ listFixJobs: async () => null });
    const out = await approveQueuedFix(d, cb(), seeded(), ITEM, ctx);
    expect(apply).not.toHaveBeenCalled();
    expect(out.state.audit[0]!.detail).toMatch(/unverifiable/);
  });

  test("a fix already in flight is left alone", async () => {
    const { d, apply } = deps({ jobExists: true });
    const state = seeded();
    const out = await approveQueuedFix(d, cb(), state, ITEM, ctx);
    expect(apply).not.toHaveBeenCalled();
    expect(out.state).toBe(state);
    expect(out.reply).toBe('"Open fix PR" is already being opened.');
  });

  test("a workload no longer eligible is recorded and the item is dropped", async () => {
    const { d, apply } = deps({ eligibility: async () => ({ inScope: false, repo: null }) });
    const out = await approveQueuedFix(d, cb(), seeded(), ITEM, ctx);
    expect(apply).not.toHaveBeenCalled();
    expect(out.state.queue).toHaveLength(0);
    expect(out.state.audit[0]).toMatchObject({ outcome: "skipped", verdict: "approved" });
    expect(out.reply).toMatch(/^✗ Couldn't open the fix PR: openFixPR proposed, but autofix is disabled/);
  });
});

describe("consumeFixApprovals", () => {
  const approval = { id: `${ITEM.at}|${ITEM.incident}|${ITEM.suggestion}`, fingerprint: FP, token: "tok-1", at: 1 };

  test("dispatches a matching item once and stamps its token", async () => {
    const { d, apply } = deps();
    const first = await consumeFixApprovals(d, cb(), seeded(), [approval], { ...ctx, actor: "pr" });
    expect(apply).toHaveBeenCalledTimes(2);
    expect(first.notifications).toHaveLength(1);
    expect(first.state.approvedFixTokens).toEqual(["tok-1"]);
    expect(first.state.audit[0]).toMatchObject({ verdict: "approved", actor: "pr" });

    const again = await consumeFixApprovals(d, cb(), { ...first.state, queue: [ITEM] }, [approval], ctx);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(again.notifications).toHaveLength(0);
  });

  test("a marker whose item is gone is retired without dispatching", async () => {
    const { d, apply } = deps();
    const out = await consumeFixApprovals(d, cb(), emptyState(), [approval], ctx);
    expect(apply).not.toHaveBeenCalled();
    expect(out.state.approvedFixTokens).toEqual(["tok-1"]);
  });

  test("a marker never matches a pending item", async () => {
    const { d, apply } = deps();
    const out = await consumeFixApprovals(d, cb(), { ...emptyState(), queue: [{ ...ITEM, pending: true }] }, [approval], ctx);
    expect(apply).not.toHaveBeenCalled();
    expect(out.state.queue).toEqual([{ ...ITEM, pending: true }]);
  });

  test("a marker never matches a different fingerprint", async () => {
    const { d, apply } = deps();
    await consumeFixApprovals(d, cb(), seeded(), [{ ...approval, fingerprint: "other" }], ctx);
    expect(apply).not.toHaveBeenCalled();
  });
});
