// Pure discovery for "Recent deployments": list ledger ConfigMaps and parse their
// batch.json payloads into windowed, newest-first batches. No process spawning —
// the server (recentDeploys.ts) runs the query and calls parseLedgerBatches.

import {
  LEDGER_DATA_KEY,
  LEDGER_LABEL_KEY,
  LEDGER_LABEL_VALUE,
} from "./applyBatch";

/** Recent window: 14 days (spec §Recent deployments query). */
export const RECENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export interface RecentResource {
  kind: string;
  name: string;
  namespace: string;
}

export interface RecentBatch {
  batchId: string;
  source: string;
  appliedAt: string;
  /** The namespace the ledger ConfigMap itself lives in (for Undo). */
  ledgerNamespace: string;
  resources: RecentResource[];
}

/** A ledger ConfigMap item from `kubectl get configmap … -o json` `.items`. */
export interface LedgerItem {
  metadata?: { namespace?: string };
  data?: Record<string, string>;
}

/** Build the kubectl argv (verb onward) selecting ledger ConfigMaps everywhere. */
export function ledgerDiscoveryArgs(): string[] {
  return [
    "get", "configmap", "--all-namespaces",
    "-l", `${LEDGER_LABEL_KEY}=${LEDGER_LABEL_VALUE}`, "-o", "json",
  ];
}

/**
 * Parse ledger ConfigMaps into batches within `windowMs` of `nowMs`, newest
 * first, carrying each ledger's own namespace. Unparseable or out-of-window
 * ledgers are dropped. `nowMs` is injected for testability.
 */
export function parseLedgerBatches(
  items: LedgerItem[],
  nowMs: number,
  windowMs: number = RECENT_WINDOW_MS,
): RecentBatch[] {
  const batches: RecentBatch[] = [];
  for (const it of items) {
    const raw = it.data?.[LEDGER_DATA_KEY];
    if (!raw) continue;
    let batch: Omit<RecentBatch, "ledgerNamespace">;
    try {
      batch = JSON.parse(raw) as RecentBatch;
    } catch {
      continue;
    }
    if (!batch?.batchId || !batch.appliedAt) continue;
    const ts = Date.parse(batch.appliedAt);
    if (Number.isNaN(ts) || nowMs - ts > windowMs) continue;
    batches.push({
      batchId: batch.batchId,
      source: batch.source ?? "",
      appliedAt: batch.appliedAt,
      ledgerNamespace: it.metadata?.namespace ?? "default",
      resources: Array.isArray(batch.resources) ? batch.resources : [],
    });
  }
  return batches.sort((a, b) => Date.parse(b.appliedAt) - Date.parse(a.appliedAt));
}
