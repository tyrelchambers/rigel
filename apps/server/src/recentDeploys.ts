// Recent deployments / Undo — server route logic.
//   GET  /api/deployments/recent → list ledger ConfigMaps, parse into batches.
//   POST /api/deployments/undo   → re-read a batch's ledger, delete each
//        recorded resource (ignore-not-found), then delete the ledger.
// Binaries spawn via argv arrays (no shell); --context is prepended by kubectl.

import { kubectl, type RunResult } from "@rigel/k8s/src/run";
import {
  LEDGER_DATA_KEY,
  expiredLedgers,
  ledgerDiscoveryArgs,
  ledgerName,
  parseLedgerBatches,
  type LedgerItem,
  type RecentBatch,
} from "@rigel/k8s";

export interface RecentRunners {
  kubectlRun: (context: string | null, args: string[]) => Promise<RunResult>;
}

const defaultRunners: RecentRunners = { kubectlRun: kubectl };

export interface DiscoverRecentResponse {
  batches: RecentBatch[];
}

export interface UndoResultEntry {
  resource: string;
  ok: boolean;
  detail: string;
}

export interface UndoResponse {
  ok: boolean;
  results: UndoResultEntry[];
}

/** List ledger ConfigMaps and return windowed, newest-first batches. */
export async function discoverRecent(
  context: string | null,
  nowMs: number,
  runners: RecentRunners = defaultRunners,
): Promise<DiscoverRecentResponse> {
  const res = await runners.kubectlRun(context, ledgerDiscoveryArgs());
  if (res.code !== 0) return { batches: [] };
  let items: LedgerItem[] = [];
  try {
    const parsed = JSON.parse(res.stdout) as { items?: LedgerItem[] };
    items = Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return { batches: [] };
  }
  // GC: delete ledgers older than the 14-day window (best-effort) so the "Undo
  // available for 14 days" retention holds even for batches that are never
  // undone. Runs whenever Recent is fetched.
  for (const ref of expiredLedgers(items, nowMs)) {
    await runners.kubectlRun(context, [
      "delete", "configmap", ref.name, "-n", ref.namespace, "--ignore-not-found",
    ]);
  }
  return { batches: parseLedgerBatches(items, nowMs) };
}

/**
 * Delete every resource recorded in a batch's ledger, then delete the ledger.
 * `namespace` is the ledger ConfigMap's own namespace (carried from discovery).
 */
export async function undoBatch(
  context: string | null,
  batchId: string,
  namespace: string,
  runners: RecentRunners = defaultRunners,
): Promise<UndoResponse> {
  const cmName = ledgerName(batchId);
  const get = await runners.kubectlRun(context, ["get", "configmap", cmName, "-n", namespace, "-o", "json"]);
  if (get.code !== 0) {
    return { ok: false, results: [{ resource: `batch/${batchId}`, ok: false, detail: "ledger not found" }] };
  }
  let resources: RecentBatch["resources"] = [];
  try {
    const cm = JSON.parse(get.stdout) as { data?: Record<string, string> };
    const batch = JSON.parse(cm.data?.[LEDGER_DATA_KEY] ?? "{}") as RecentBatch;
    resources = Array.isArray(batch.resources) ? batch.resources : [];
  } catch {
    return { ok: false, results: [{ resource: `batch/${batchId}`, ok: false, detail: "ledger unreadable" }] };
  }

  const results: UndoResultEntry[] = [];
  for (const r of resources) {
    const del = await runners.kubectlRun(context, ["delete", r.kind, r.name, "-n", r.namespace, "--ignore-not-found"]);
    const ok = del.code === 0;
    results.push({ resource: `${r.kind}/${r.name}`, ok, detail: ok ? "deleted" : (del.stderr.trim() || `exit ${del.code}`) });
  }

  const allOk = results.every((r) => r.ok);
  if (allOk) {
    await runners.kubectlRun(context, ["delete", "configmap", cmName, "-n", namespace, "--ignore-not-found"]);
  }
  return { ok: allOk, results };
}
