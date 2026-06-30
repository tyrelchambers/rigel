import { appendAudit, type AssistantState, type QueuedSuggestion } from "./state.js";
import type { SuggestedAction } from "./action.js";
import type { ResolvedRepo } from "./repoResolve.js";
import type { KubectlResult } from "./kubectl.js";
import {
  buildFixJob,
  buildFixSpecConfigMap,
  fixJobId,
  fixResourceName,
  type FixMeta,
  type FixSpec,
} from "./fixJob.js";

/**
 * The dispatch seam for an `openFixPR` proposal. It validates the proposal,
 * creates the per-fix ConfigMap + one-shot Job that actually opens the PR (the
 * fixRunner does the git/PR work — the agent only ORCHESTRATES), and records the
 * pending outcome into the agent's state. It NEVER holds a token, runs git, or
 * throws — every cluster touch is the injected `deps` (so it is unit-testable),
 * and IO failures are captured into the recorded outcome.
 *
 *   - out of scope     → skipped (autofix off, or the workload isn't opted in)
 *   - no GitOps source → skipped (not autofix-eligible)
 *   - eligible         → ConfigMap+Job created (deduped by fingerprint+filePath),
 *                        queued pending the fix-runner, surfaced for visibility
 *
 * The two skip short-circuits run BEFORE any Job/ConfigMap creation, so the
 * non-dispatchable call site can never create a Job. The supervisor-approve gate
 * lives upstream in tick(), ahead of the approve-path call.
 */
export interface RepoFixDeps {
  /** True when a fix Job already exists for this id (dedup — don't re-create). */
  jobExists: (name: string, namespace: string) => Promise<boolean>;
  /** Apply a manifest (the agent's `kubectlApply` — JSON piped to `kubectl apply -f -`). */
  apply: (manifest: string) => Promise<KubectlResult>;
}

export interface RepoFixDispatch {
  at: string;
  fingerprint: string;
  /** Human-readable incident description (from the loop's `describe`). */
  incident: string;
  action: SuggestedAction;
  analysis: string;
  /** The resolved GitOps source, or null when the workload isn't tracked. */
  repo: ResolvedRepo | null;
  /** autofix enabled AND this workload within the autofix scope. */
  inScope: boolean;
  auditMaxEntries: number;
  /** Namespace the fix ConfigMap + Job are created in (the agent's state ns). */
  namespace: string;
  /** The fix-runner image (same immutable tag as the agent) the Job runs. */
  image: string;
}

export interface RepoFixOutcome {
  state: AssistantState;
  /** A line to surface in this tick's notifications when a fix PR was queued. */
  notification?: string;
}

/** Map the resolved GitOps source + the proposal into the fixRunner's spec. The
 *  source `name` is the deployment slug (proposeRepoFix's clone workdir id). */
function toFixSpec(repo: ResolvedRepo, action: SuggestedAction): FixSpec {
  return {
    source: { name: repo.source, repoURL: repo.repoURL, branch: repo.branch, path: repo.path },
    filePath: action.filePath ?? "",
    content: action.content ?? "",
    title: (action.title && action.title.trim()) || action.label,
    body: action.body,
  };
}

export async function dispatchRepoFix(
  deps: RepoFixDeps,
  state: AssistantState,
  d: RepoFixDispatch,
): Promise<RepoFixOutcome> {
  if (!d.inScope) {
    return {
      state: appendAudit(state, {
        at: d.at, fingerprint: d.fingerprint, incident: d.incident, proposal: d.action.label,
        tier: "medium", outcome: "skipped",
        detail: "openFixPR proposed, but autofix is disabled or this workload is outside the autofix scope",
        analysis: truncate(d.analysis),
      }, d.auditMaxEntries),
    };
  }
  if (!d.repo) {
    return {
      state: appendAudit(state, {
        at: d.at, fingerprint: d.fingerprint, incident: d.incident, proposal: d.action.label,
        tier: "medium", outcome: "skipped",
        detail: "openFixPR proposed, but the workload has no GitOps source (not autofix-eligible)",
        analysis: truncate(d.analysis),
      }, d.auditMaxEntries),
    };
  }

  const suggestion = d.action.title && d.action.title.trim() ? d.action.title.trim() : d.action.label;

  // Create the fix ConfigMap + Job that opens the PR. Deterministic id from
  // fingerprint+filePath ⇒ stable resource names ⇒ idempotent: if a Job already
  // exists for this fix we skip re-creating it (don't spam Jobs). A misconfigured
  // image or an apply error is recorded as a failure — never thrown.
  const id = fixJobId(d.fingerprint, d.action.filePath ?? "");
  const name = fixResourceName(id);
  try {
    if (!d.image) {
      return {
        state: appendAudit(state, {
          at: d.at, fingerprint: d.fingerprint, incident: d.incident, proposal: suggestion,
          tier: "medium", outcome: "failure",
          detail: "openFixPR approved, but the fix-runner image is not configured (RIGEL_FIX_RUNNER_IMAGE): cannot open the PR",
          analysis: truncate(d.analysis),
        }, d.auditMaxEntries),
      };
    }
    if (!(await deps.jobExists(name, d.namespace))) {
      const spec = toFixSpec(d.repo, d.action);
      // Provenance stamped on both resources so the Phase-4 reconcile can rebuild
      // the PullRequestRecord + notification from the completed Job alone.
      const meta: FixMeta = {
        fingerprint: d.fingerprint,
        filePath: d.action.filePath ?? "",
        incident: d.incident,
        repoURL: d.repo.repoURL,
        branch: d.repo.branch,
        source: d.repo.source,
        title: suggestion,
      };
      const cm = await deps.apply(JSON.stringify(buildFixSpecConfigMap(d.namespace, id, spec, meta)));
      if (cm.code !== 0) throw new Error(`creating the fix ConfigMap failed: ${cm.stderr || cm.stdout}`);
      const job = await deps.apply(JSON.stringify(buildFixJob({ namespace: d.namespace, id, image: d.image, meta })));
      if (job.code !== 0) throw new Error(`creating the fix Job failed: ${job.stderr || job.stdout}`);
    }
  } catch (err) {
    return {
      state: appendAudit(state, {
        at: d.at, fingerprint: d.fingerprint, incident: d.incident, proposal: suggestion,
        tier: "medium", outcome: "failure",
        detail: truncate(`openFixPR approved, but the fix Job could not be created (fail-safe): ${String(err)}`),
        analysis: truncate(d.analysis),
      }, d.auditMaxEntries),
    };
  }

  const detail = `fix PR opening (pending the fix-runner): ${d.repo.repoURL}@${d.repo.branch} (${d.repo.path})`;
  let next = appendAudit(state, {
    at: d.at, fingerprint: d.fingerprint, incident: d.incident, proposal: suggestion,
    tier: "medium", outcome: "queued", detail, analysis: truncate(d.analysis),
  }, d.auditMaxEntries);

  // Surface the pending fix in the approval queue for visibility. The fix-runner
  // Job (not the kubectl executor) opens the PR; the approve path refuses to
  // "run" a repo-fix item, so this can never reach the executor.
  const exists = next.queue.some((q) => q.incident === d.incident && q.suggestion === suggestion);
  if (!exists) {
    const queued: QueuedSuggestion = {
      at: d.at, fingerprint: d.fingerprint, incident: d.incident, suggestion,
      reason: "fix PR pending the fix-runner", action: d.action,
    };
    next = { ...next, queue: [queued, ...next.queue].slice(0, d.auditMaxEntries) };
  }
  return { state: next, notification: `▸ Fix PR pending: ${suggestion} (${d.incident})` };
}

function truncate(s: string, max = 2000): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}
