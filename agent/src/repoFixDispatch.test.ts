import { describe, expect, test, vi } from "vitest";
import { dispatchRepoFix, type RepoFixDeps, type RepoFixDispatch } from "./repoFixDispatch.js";
import { emptyState } from "./state.js";
import type { SuggestedAction } from "./action.js";
import type { ResolvedRepo } from "./repoResolve.js";
import type { KubectlResult } from "./kubectl.js";

const REPO: ResolvedRepo = { source: "memos", repoURL: "https://github.com/me/infra", branch: "main", path: "apps/memos" };

const ACTION: SuggestedAction = {
  label: "Open fix PR",
  kind: "openFixPR",
  source: "memos",
  filePath: "apps/memos/deployment.yaml",
  content: "kind: Deployment\n...",
  title: "Bump memos image to a healthy tag",
  body: "The current tag CrashLoops.",
};

const ok: KubectlResult = { stdout: "", stderr: "", code: 0 };

/** Deps with a fresh apply spy + a controllable job-existence answer. */
function deps(over: Partial<RepoFixDeps> = {}): { d: RepoFixDeps; applied: () => unknown[] } {
  const apply = vi.fn<(manifest: string) => Promise<KubectlResult>>(async () => ok);
  const d: RepoFixDeps = {
    jobExists: async () => false,
    apply,
    ...over,
  };
  return { d, applied: () => apply.mock.calls.map((c) => JSON.parse(c[0])) };
}

function base(overrides: Partial<RepoFixDispatch> = {}): RepoFixDispatch {
  return {
    at: "2026-06-29T00:00:00.000Z",
    fingerprint: "unhealthyPod|default|memos-abc|CrashLoopBackOff",
    incident: "default/memos-abc: CrashLoopBackOff",
    action: ACTION,
    analysis: "image tag is wrong",
    repo: REPO,
    inScope: true,
    auditMaxEntries: 200,
    namespace: "default",
    image: "ghcr.io/me/rigel-assistant:abc123",
    ...overrides,
  };
}

describe("dispatchRepoFix", () => {
  test("eligible + in scope → creates the fix ConfigMap + Job and records a 'pending' queued outcome", async () => {
    const { d, applied } = deps();
    const { state, notification } = await dispatchRepoFix(d, emptyState(), base());

    const kinds = applied().map((m) => (m as { kind: string }).kind);
    expect(kinds).toEqual(["ConfigMap", "Job"]); // ConfigMap first, then the Job
    expect(state.audit[0]).toMatchObject({ outcome: "queued", tier: "medium", proposal: ACTION.title });
    expect(state.audit[0]?.detail).toContain("fix-runner");
    expect(state.audit[0]?.detail).toContain("github.com/me/infra@main");
    expect(state.queue[0]).toMatchObject({ suggestion: ACTION.title, action: { kind: "openFixPR" } });
    expect(notification).toContain("Fix PR pending");
  });

  test("out of scope → skipped, NO Job/ConfigMap created, nothing queued", async () => {
    const { d, applied } = deps();
    const { state, notification } = await dispatchRepoFix(d, emptyState(), base({ inScope: false }));
    expect(applied()).toHaveLength(0);
    expect(state.audit[0]?.outcome).toBe("skipped");
    expect(state.audit[0]?.detail).toMatch(/autofix is disabled or this workload is outside/);
    expect(state.queue).toHaveLength(0);
    expect(notification).toBeUndefined();
  });

  test("no resolved GitOps source → skipped, NO Job created (not autofix-eligible)", async () => {
    const { d, applied } = deps();
    const { state } = await dispatchRepoFix(d, emptyState(), base({ repo: null }));
    expect(applied()).toHaveLength(0);
    expect(state.audit[0]?.outcome).toBe("skipped");
    expect(state.audit[0]?.detail).toMatch(/no GitOps source/);
    expect(state.queue).toHaveLength(0);
  });

  test("falls back to the action label when no title is given", async () => {
    const { d } = deps();
    const { state } = await dispatchRepoFix(d, emptyState(), base({ action: { ...ACTION, title: undefined } }));
    expect(state.audit[0]?.proposal).toBe("Open fix PR");
  });

  test("does not double-queue, and skips re-creating the Job when one already exists (dedup)", async () => {
    const { d, applied } = deps({ jobExists: async () => true });
    const first = await dispatchRepoFix(d, emptyState(), base());
    const second = await dispatchRepoFix(d, first.state, base());
    expect(applied()).toHaveLength(0); // Job already exists → never re-applied
    expect(second.state.queue).toHaveLength(1);
  });

  test("an unconfigured image is recorded as a failure, no Job created", async () => {
    const { d, applied } = deps();
    const { state } = await dispatchRepoFix(d, emptyState(), base({ image: "" }));
    expect(applied()).toHaveLength(0);
    expect(state.audit[0]).toMatchObject({ outcome: "failure" });
    expect(state.audit[0]?.detail).toMatch(/RIGEL_FIX_RUNNER_IMAGE/);
  });

  test("an apply failure is captured as a failure outcome, never thrown", async () => {
    const { d } = deps({ apply: async () => ({ stdout: "", stderr: "forbidden", code: 1 }) });
    const { state } = await dispatchRepoFix(d, emptyState(), base());
    expect(state.audit[0]).toMatchObject({ outcome: "failure" });
    expect(state.audit[0]?.detail).toMatch(/could not be created/);
  });

  test("never throws", async () => {
    const { d } = deps();
    await expect(dispatchRepoFix(d, emptyState(), base())).resolves.toBeDefined();
  });
});
