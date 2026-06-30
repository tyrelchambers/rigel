import { kubectl, kubectlApply } from "./kubectl.js";
import type { SuggestedAction } from "./action.js";
import { emptyAlertState, type AlertState } from "./alerts.js";

/**
 * The agent's externally-visible state, persisted to the `assistant-state`
 * ConfigMap so Rigel can render it (audit timeline, morning report, queued
 * suggestions). The agent owns this object; human-editable knobs and the
 * kill-switch live in a separate `assistant-config` ConfigMap (see config.ts)
 * so the agent never clobbers them.
 */

export type Tier = "low" | "medium" | "blocked";
export type Verdict = "auto" | "approved" | "rejected" | "escalated" | "skipped";
export type Outcome = "success" | "failure" | "queued" | "skipped";

export interface AuditEntry {
  at: string;
  fingerprint: string;
  incident: string;
  proposal?: string;
  command?: string;
  tier: Tier;
  verdict?: Verdict;
  outcome: Outcome;
  detail: string;
  backupRef?: string;
  /** The worker's full prose reasoning + the supervisor verdict reason, for the
   * Rigel drill-down (why the agent did what it did). */
  analysis?: string;
}

/** A remediation the agent could not perform (RBAC-blocked / destructive), left
 * for the human to run from Rigel in the morning. */
export interface QueuedSuggestion {
  at: string;
  incident: string;
  suggestion: string;
  reason: string;
  /** Stable incident identity (detector `fingerprint`) so the queue can be
   * re-validated each poll and moot items auto-cleared. Optional for back-compat
   * with items persisted before this field existed. */
  fingerprint?: string;
  /** The structured action, when one exists (escalated MEDIUM items). Lets
   * Rigel render a runnable button → confirm sheet. Absent for destructive
   * suggestions, which have no expressible action kind. */
  action?: SuggestedAction;
}

export interface QueueReconcileResult {
  kept: QueuedSuggestion[];
  cleared: { item: QueuedSuggestion; reason: string }[];
}

/**
 * Re-validate the approval queue against live detection so stale suggestions
 * don't linger. An item is moot when its incident fingerprint is no longer
 * present AND detection for that incident kind actually ran this tick — so an
 * empty/failed detection never wrongly clears the queue. Items we can't confirm
 * (no fingerprint, or their kind wasn't checked this tick) are kept until a long
 * TTL backstop expires them. Pure — returns the partition, mutates nothing.
 */
export function reconcileQueue(
  queue: QueuedSuggestion[],
  present: ReadonlySet<string>,
  checkedKinds: ReadonlySet<string>,
  nowMs: number,
  ttlMs: number,
): QueueReconcileResult {
  const kept: QueuedSuggestion[] = [];
  const cleared: { item: QueuedSuggestion; reason: string }[] = [];
  for (const item of queue) {
    const fp = item.fingerprint;
    if (fp && present.has(fp)) {
      kept.push(item); // condition still active — keep awaiting approval
      continue;
    }
    const kind = fp ? fp.split("|")[0] : undefined;
    if (kind && checkedKinds.has(kind)) {
      cleared.push({ item, reason: "auto-cleared: the underlying condition is no longer present" });
      continue;
    }
    const ageMs = nowMs - Date.parse(item.at);
    if (Number.isFinite(ageMs) && ageMs > ttlMs) {
      cleared.push({ item, reason: `auto-cleared: stale (older than ${Math.round(ttlMs / 3_600_000)}h, unverified)` });
      continue;
    }
    kept.push(item);
  }
  return { kept, cleared };
}

/**
 * A fix PR the agent opened (or tried to). Recorded by the Phase-4 reconcile once
 * the one-shot fix-runner Job finishes and reports its result, so Rigel can render
 * the agent's PR history. `at` is when it was recorded; `prUrl`/`branch` are absent
 * on a failure. `filePath` (with `fingerprint`) is the dedup identity so a Job
 * reconciled twice before GC is not double-recorded. */
export interface PullRequestRecord {
  at: string;
  fingerprint: string;
  /** The fixed file's repo-relative path — half the dedup key, also useful UI. */
  filePath: string;
  /** Human-readable incident description (the loop's `describe`). */
  incident: string;
  /** The workload / GitOps slug the PR is for. */
  app: string;
  /** The repo URL the PR was opened against. */
  repo: string;
  /** The PR's head branch (from the runner), absent on failure. */
  branch?: string;
  /** The opened PR URL, absent on failure. */
  prUrl?: string;
  title: string;
  /** A short result line — the runner's note, or the failure message. */
  summary: string;
  status: "open" | "failed";
  /** The fix class. Today only config-file PRs exist (`openFixPR`). */
  kind: "config";
}

export interface AgentStatus {
  heartbeatAt: string;
  enabled: boolean;
  version: string;
}

export interface AssistantState {
  updatedAt: string;
  status?: AgentStatus;
  alertState?: AlertState;
  audit: AuditEntry[];
  queue: QueuedSuggestion[];
  report: string;
  /** Matrix /sync cursor, persisted so a restart resumes without reprocessing or
   *  missing events. Absent until the first inbound poll. */
  matrixSince?: string;
  /** Fingerprints the agent auto-silenced after an "acceptable" triage, so the
   *  same benign incident doesn't re-fire. Agent-owned and persisted here (the
   *  human `silenced` set lives separately in assistant-config); the loop unions
   *  both when filtering detected incidents. Capped, newest-first. */
  autoSilenced?: string[];
  /** Fix PRs the agent opened (or tried to), recorded by the reconcile once each
   *  one-shot fix-runner Job finishes. Capped, newest-first. Absent until the
   *  first fix is reconciled. */
  pullRequests?: PullRequestRecord[];
}

/** Cap on the agent-owned auto-silence list, so it can't grow without bound. On
 *  overflow the oldest entry drops; if its incident recurs and is still benign it
 *  is simply re-triaged and re-silenced. */
const MAX_AUTO_SILENCED = 200;

export function emptyState(): AssistantState {
  return { updatedAt: "", audit: [], queue: [], report: "", alertState: emptyAlertState() };
}

/** Prepend an audit entry (newest first), cap the log, and stamp updatedAt.
 * Pure — returns a new state, never mutates the input. */
export function appendAudit(state: AssistantState, entry: AuditEntry, maxEntries: number): AssistantState {
  const audit = [entry, ...state.audit].slice(0, maxEntries);
  return { ...state, audit, updatedAt: entry.at };
}

/** Add a fingerprint to the agent-owned auto-silence set (newest-first, deduped,
 * capped). Pure — returns a new state, never mutates the input. A no-op when the
 * fingerprint is already silenced, so it doesn't reorder/grow the list. */
export function autoSilence(state: AssistantState, fingerprint: string, max = MAX_AUTO_SILENCED): AssistantState {
  const existing = state.autoSilenced ?? [];
  if (existing.includes(fingerprint)) return state;
  return { ...state, autoSilenced: [fingerprint, ...existing].slice(0, max) };
}

/** Cap on the recorded fix-PR history, so it can't grow without bound. */
const MAX_PULL_REQUESTS = 100;

/**
 * Record a fix PR (newest-first, capped), deduped by `fingerprint` + `filePath` so
 * a Job reconciled more than once before its GC isn't double-recorded. Returns the
 * new state and whether it was actually `added` — the reconcile gates the audit
 * update + the operator notification on `added` so they fire exactly once. Pure —
 * never mutates the input. */
export function recordPullRequest(
  state: AssistantState,
  record: PullRequestRecord,
  max = MAX_PULL_REQUESTS,
): { state: AssistantState; added: boolean } {
  const existing = state.pullRequests ?? [];
  const dup = existing.some(
    (p) => p.fingerprint === record.fingerprint && p.filePath === record.filePath,
  );
  if (dup) return { state, added: false };
  return { state: { ...state, pullRequests: [record, ...existing].slice(0, max) }, added: true };
}

/** The rolling window for the per-day fix-PR budget (24h). */
export const FIX_PR_BUDGET_WINDOW_MS = 24 * 3_600_000;

/**
 * Count fix PRs that consume the rolling-24h budget: real opened PRs recorded in
 * the window (`status: "open"`) PLUS the fix Jobs currently in flight (dispatched
 * but not yet reconciled into `pullRequests`). The two are disjoint in steady
 * state — a reconciled Job is GC'd the same tick it is recorded — so the only
 * overlap is a Job whose post-record GC failed, which OVER-counts (conservative,
 * never under-counts), keeping the cap unbreachable. A "failed" record never
 * counts (it opened no PR); a record whose `at` is unparsable is dropped. Pure —
 * the caller adds any same-tick dispatches on top of this baseline. */
export function countFixPrBudget(
  pullRequests: PullRequestRecord[] | undefined,
  inFlightJobCount: number,
  nowMs: number,
  windowMs = FIX_PR_BUDGET_WINDOW_MS,
): number {
  const since = nowMs - windowMs;
  const recordedOpen = (pullRequests ?? []).filter((p) => {
    if (p.status !== "open") return false;
    const at = Date.parse(p.at);
    return Number.isFinite(at) && at >= since;
  }).length;
  return recordedOpen + Math.max(0, inFlightJobCount);
}

/**
 * Replace the dispatch's PENDING fix-PR audit entry (the "queued pending the
 * fix-runner" placeholder) for this `fingerprint` + `title` with its terminal
 * outcome (opened / failed). When no pending entry is found (e.g. rotated out of
 * the capped log), the terminal entry is prepended instead. The pending entry is
 * the only queued/medium entry with NO verdict for this fingerprint+proposal —
 * escalated items carry a verdict, so they are never matched. Pure. */
export function resolveFixAudit(
  state: AssistantState,
  fingerprint: string,
  title: string,
  terminal: AuditEntry,
  maxEntries: number,
): AssistantState {
  const idx = state.audit.findIndex(
    (e) => e.fingerprint === fingerprint && e.outcome === "queued" && e.verdict === undefined && e.proposal === title,
  );
  if (idx === -1) return appendAudit(state, terminal, maxEntries);
  const audit = state.audit.map((e, i) => (i === idx ? terminal : e));
  return { ...state, audit, updatedAt: terminal.at };
}

/** Keep only the newest `max` backup keys. Backup keys are timestamp-prefixed,
 * so lexical order is chronological — we keep the largest (newest) keys. Pure. */
export function capBackups(data: Record<string, string>, max: number): Record<string, string> {
  const keys = Object.keys(data).sort();
  const kept = keys.slice(Math.max(0, keys.length - max));
  const out: Record<string, string> = {};
  for (const k of kept) out[k] = data[k]!;
  return out;
}

// ── ConfigMap persistence (IO glue) ──────────────────────────────────────────

const STATE_KEY = "state.json";

export async function readState(name: string, namespace: string): Promise<AssistantState> {
  const res = await kubectl(["get", "configmap", name, "-n", namespace, "-o", "json"]);
  if (res.code !== 0) return emptyState(); // not yet created → start fresh
  try {
    const cm = JSON.parse(res.stdout) as { data?: Record<string, string> };
    const raw = cm.data?.[STATE_KEY];
    return raw ? (JSON.parse(raw) as AssistantState) : emptyState();
  } catch {
    return emptyState();
  }
}

export async function writeState(name: string, namespace: string, state: AssistantState): Promise<void> {
  const manifest = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name, namespace, labels: { "app.kubernetes.io/managed-by": "rigel-assistant" } },
    data: { [STATE_KEY]: JSON.stringify(state) },
  };
  await kubectlApply(JSON.stringify(manifest));
}

/** Append a pre-mutation backup snapshot to the backups ConfigMap (read-modify-
 * write), capping the total kept. Returns the backup key for the audit entry. */
export async function storeBackup(
  name: string,
  namespace: string,
  key: string,
  yaml: string,
  maxBackups: number,
): Promise<string> {
  const res = await kubectl(["get", "configmap", name, "-n", namespace, "-o", "json"]);
  let data: Record<string, string> = {};
  if (res.code === 0) {
    try {
      data = (JSON.parse(res.stdout) as { data?: Record<string, string> }).data ?? {};
    } catch {
      data = {};
    }
  }
  data[key] = yaml;
  const manifest = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name, namespace, labels: { "app.kubernetes.io/managed-by": "rigel-assistant" } },
    data: capBackups(data, maxBackups),
  };
  await kubectlApply(JSON.stringify(manifest));
  return key;
}
