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
}

export function emptyState(): AssistantState {
  return { updatedAt: "", audit: [], queue: [], report: "", alertState: emptyAlertState() };
}

/** Prepend an audit entry (newest first), cap the log, and stamp updatedAt.
 * Pure — returns a new state, never mutates the input. */
export function appendAudit(state: AssistantState, entry: AuditEntry, maxEntries: number): AssistantState {
  const audit = [entry, ...state.audit].slice(0, maxEntries);
  return { ...state, audit, updatedAt: entry.at };
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
