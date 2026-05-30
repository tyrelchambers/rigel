import { kubectl, kubectlApply } from "./kubectl.js";
import type { SuggestedAction } from "./action.js";

/**
 * The agent's externally-visible state, persisted to the `assistant-state`
 * ConfigMap so Helmsman can render it (audit timeline, morning report, queued
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
   * Helmsman drill-down (why the agent did what it did). */
  analysis?: string;
}

/** A remediation the agent could not perform (RBAC-blocked / destructive), left
 * for the human to run from Helmsman in the morning. */
export interface QueuedSuggestion {
  at: string;
  incident: string;
  suggestion: string;
  reason: string;
  /** The structured action, when one exists (escalated MEDIUM items). Lets
   * Helmsman render a runnable button → confirm sheet. Absent for destructive
   * suggestions, which have no expressible action kind. */
  action?: SuggestedAction;
}

export interface AgentStatus {
  heartbeatAt: string;
  spentUsd: number;
  spendCapUsd: number;
  enabled: boolean;
  version: string;
}

export interface AssistantState {
  updatedAt: string;
  status?: AgentStatus;
  /** Persisted monthly spend so the cap survives pod restarts and resets with
   * the billing month. */
  spend?: { month: string; spentUsd: number };
  audit: AuditEntry[];
  queue: QueuedSuggestion[];
  report: string;
}

export function emptyState(): AssistantState {
  return { updatedAt: "", audit: [], queue: [], report: "" };
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
    metadata: { name, namespace, labels: { "app.kubernetes.io/managed-by": "helmsman-assistant" } },
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
    metadata: { name, namespace, labels: { "app.kubernetes.io/managed-by": "helmsman-assistant" } },
    data: capBackups(data, maxBackups),
  };
  await kubectlApply(JSON.stringify(manifest));
  return key;
}
