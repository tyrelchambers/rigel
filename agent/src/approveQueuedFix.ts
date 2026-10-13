import { MAX_APPROVED_FIXES, queuedSuggestionId, type ApprovedFix } from "@rigel/k8s/src/actionLevels.js";
import { resourceKeyFor } from "./action.js";
import type { AutofixEligibility } from "./autofixEligibility.js";
import { incidentFromFingerprint, type Incident } from "./detector.js";
import { fixJobId, fixResourceName } from "./fixJob.js";
import type { CircuitBreaker } from "./guardrails.js";
import { dispatchRepoFix, type RepoFixDeps } from "./repoFixDispatch.js";
import {
  appendAudit,
  countFixPrBudget,
  fixBudgetHold,
  isApprovable,
  type AssistantState,
  type AuditActor,
  type QueuedSuggestion,
  type Tier,
} from "./state.js";

/**
 * Open a queued fix PR the operator approved, from chat or from the desktop.
 * The approval is the decision, so it skips the level, autonomy and breaker
 * checks (the breaker still counts it), but the daily fix-PR budget still caps
 * it. Eligibility (scope + GitOps source) is re-resolved now, since the item
 * may have waited a while. The item leaves the queue once dispatch is attempted.
 */
export interface ApproveFixDeps {
  repoFix: RepoFixDeps;
  /** The in-flight fix Jobs, or null when they couldn't be listed. */
  listFixJobs(): Promise<unknown[] | null>;
  eligibility(incident: Incident): Promise<AutofixEligibility>;
}

export interface ApproveFixContext {
  at: string;
  nowMs: number;
  actor: AuditActor;
  tier: Tier;
  maxPerDay: number;
  auditMaxEntries: number;
  namespace: string;
  image: string;
}

export interface ApproveFixOutcome {
  state: AssistantState;
  /** The line to answer the operator with in chat. */
  reply: string;
  /** Set when the fix PR was dispatched, for the tick's notifications. */
  notification?: string;
}

export async function approveQueuedFix(
  deps: ApproveFixDeps,
  cb: CircuitBreaker,
  state: AssistantState,
  item: QueuedSuggestion & { action: NonNullable<QueuedSuggestion["action"]> },
  ctx: ApproveFixContext,
): Promise<ApproveFixOutcome> {
  const action = item.action;
  const fp = item.fingerprint ?? "";

  if (await deps.repoFix.jobExists(fixResourceName(fixJobId(fp, action.filePath ?? "")), ctx.namespace)) {
    return { state, reply: `"${action.label}" is already being opened.` };
  }

  let inFlight: unknown[] | null;
  try {
    inFlight = await deps.listFixJobs();
  } catch {
    inFlight = null;
  }
  const hold = fixBudgetHold(inFlight === null ? null : countFixPrBudget(state.pullRequests, inFlight.length, ctx.nowMs), ctx.maxPerDay);
  if (hold) {
    const next = appendAudit(state, {
      at: ctx.at, fingerprint: fp, incident: item.incident, proposal: action.label,
      tier: ctx.tier, verdict: "approved", outcome: "skipped", detail: hold, actor: ctx.actor,
    }, ctx.auditMaxEntries);
    return { state: next, reply: `✗ Couldn't open the fix PR: ${hold}` };
  }

  const incident = incidentFromFingerprint(fp);
  let e: AutofixEligibility = { inScope: false, repo: null };
  if (incident) {
    try {
      e = await deps.eligibility(incident);
    } catch {
      e = { inScope: false, repo: null };
    }
  }

  cb.record(fp, resourceKeyFor(action), ctx.nowMs);
  const id = queuedSuggestionId(item);
  const remaining = { ...state, queue: state.queue.filter((q) => !(queuedSuggestionId(q) === id && q.fingerprint === item.fingerprint)) };
  const outcome = await dispatchRepoFix(deps.repoFix, remaining, {
    at: ctx.at, fingerprint: fp, incident: item.incident, action, analysis: "",
    repo: e.repo, inScope: e.inScope, auditMaxEntries: ctx.auditMaxEntries,
    namespace: ctx.namespace, image: ctx.image, tier: ctx.tier, actor: ctx.actor, verdict: "approved",
  });
  if (!outcome.notification) {
    return { state: outcome.state, reply: `✗ Couldn't open the fix PR: ${outcome.state.audit[0]?.detail ?? "unknown error"}` };
  }
  return { state: outcome.state, reply: `✓ ${outcome.notification.replace(/^▸ /, "")}`, notification: outcome.notification };
}

/** Act on the desktop's fix-PR approvals: each marker dispatches its queued item
 *  at most once, then its token is stamped so a leftover marker never re-fires.
 *  A marker whose item is gone (dispatched, cleared, or re-queued) is retired. */
export async function consumeFixApprovals(
  deps: ApproveFixDeps,
  cb: CircuitBreaker,
  state: AssistantState,
  approvals: ApprovedFix[],
  ctx: ApproveFixContext,
): Promise<{ state: AssistantState; notifications: string[] }> {
  const notifications: string[] = [];
  for (const approval of approvals) {
    if ((state.approvedFixTokens ?? []).includes(approval.token)) continue;
    const item = state.queue.filter(isApprovable).find(
      (q) => queuedSuggestionId(q) === approval.id && q.fingerprint === approval.fingerprint && q.action.kind === "openFixPR",
    );
    if (item) {
      const out = await approveQueuedFix(deps, cb, state, item, ctx);
      state = out.state;
      if (out.notification) notifications.push(out.notification);
    }
    state = { ...state, approvedFixTokens: [approval.token, ...(state.approvedFixTokens ?? [])].slice(0, MAX_APPROVED_FIXES * 2) };
  }
  return { state, notifications };
}
