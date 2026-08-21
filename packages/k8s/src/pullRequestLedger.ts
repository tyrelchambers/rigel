// The chat-copilot PR ledger: PRs the chat assistant opened, persisted so the
// "Pending PRs" card can watch each one's status and offer Sync-on-merge. Stored
// as a JSON array in the rigel-pull-requests ConfigMap (server-owned).

import type { RepoFixOrigin } from "./repoFix.js";

export const PULL_REQUESTS_CONFIGMAP = "rigel-pull-requests";
export const PULL_REQUESTS_DATA_KEY = "pull-requests.json";

const MANAGED_BY = { "app.kubernetes.io/managed-by": "rigel" };
const DEFAULT_MAX = 50;
const DEFAULT_TTL_DAYS = 30;

/** One chat-opened PR, enough to display it and drive a Sync of its deployment. */
export interface ChatPrRecord {
  id: string;
  prUrl: string;
  number: number;
  /** owner/repo, for display. */
  repoSlug: string;
  /** GitSource.name — the sync API key. */
  repoName: string;
  /** Deployment slug (the proposeRepoFix source). */
  source: string;
  title: string;
  branch: string;
  filePath: string;
  createdAt: string;
  /** Which surface opened it. Absent on records written before voice existed. */
  origin?: RepoFixOrigin;
}

/** Prepend a record, dedup by prUrl, drop TTL-expired entries, cap the list. */
export function addPrRecord(
  list: ChatPrRecord[],
  record: ChatPrRecord,
  opts: { now: number; max?: number; ttlDays?: number },
): ChatPrRecord[] {
  const max = opts.max ?? DEFAULT_MAX;
  const cutoff = opts.now - (opts.ttlDays ?? DEFAULT_TTL_DAYS) * 86_400_000;
  const deduped = list.filter((r) => r.prUrl !== record.prUrl);
  return [record, ...deduped].filter((r) => Date.parse(r.createdAt) >= cutoff).slice(0, max);
}

/** Parse the ledger's JSON array (empty on missing/invalid input). */
export function parsePullRequests(dataJSON: string | undefined | null): ChatPrRecord[] {
  if (!dataJSON) return [];
  try {
    const parsed = JSON.parse(dataJSON);
    return Array.isArray(parsed) ? (parsed as ChatPrRecord[]) : [];
  } catch {
    return [];
  }
}

/** Build the ledger ConfigMap manifest JSON. */
export function pullRequestsConfigMapJSON(namespace: string, records: ChatPrRecord[]): string {
  return JSON.stringify({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: PULL_REQUESTS_CONFIGMAP, namespace, labels: MANAGED_BY },
    data: { [PULL_REQUESTS_DATA_KEY]: JSON.stringify(records) },
  });
}
