// Server side of the AI-action audit ledger (HELM-18): the durable record of
// every mutation the chat and voice surfaces perform, written to the
// `rigel-chat-actions` ConfigMap. Mirrors git.ts's PR-ledger conventions
// (kubectl get to read, applyManifest to write, best-effort on failure).

import { kubectl, type RunResult } from "@rigel/k8s/src/run";
import {
  AI_ACTIONS_CONFIGMAP,
  AI_ACTIONS_DATA_KEY,
  aiActionsConfigMapJSON,
  appendAiAction,
  parseAiActions,
  type AiActionEntry,
} from "@rigel/k8s/src/aiActionLedger";
import { applyManifest } from "./install";
import { STATE_NAMESPACE } from "./git";

export interface AiActionLedgerDeps {
  load(context: string | null): Promise<AiActionEntry[]>;
  save(context: string | null, entries: AiActionEntry[]): Promise<RunResult>;
  log(message: string): void;
}

/** Read the ledger (empty when absent or unparseable). */
async function loadAiActions(context: string | null): Promise<AiActionEntry[]> {
  const res = await kubectl(context, [
    "get", "configmap", AI_ACTIONS_CONFIGMAP, "-n", STATE_NAMESPACE, "-o", "json",
  ]);
  if (res.code !== 0) return [];
  try {
    const cm = JSON.parse(res.stdout) as { data?: Record<string, string> };
    return parseAiActions(cm.data?.[AI_ACTIONS_DATA_KEY]);
  } catch {
    return [];
  }
}

const defaultDeps: AiActionLedgerDeps = {
  load: loadAiActions,
  save: (context, entries) => applyManifest(context, aiActionsConfigMapJSON(STATE_NAMESPACE, entries)),
  log: (message) => process.stderr.write(`${message}\n`),
};

// The ledger is a read-modify-write over a single ConfigMap, so two appends that
// overlap would each write a list missing the other's entry. This tail chains
// every append behind the previous one; because the server is a single Node
// process and the ConfigMap has no other writer, that is a complete fix. Each
// job resolves rather than rejects, so one failure cannot break the chain.
let tail: Promise<unknown> = Promise.resolve();

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = tail.then(job, job);
  tail = run.catch(() => undefined);
  return run;
}

export interface AiActionRecordResult {
  ok: boolean;
  message?: string;
}

/**
 * Append an entry to the ledger, serialized against every other append.
 * Best-effort by contract: the mutation it records has already happened, so a
 * ledger failure is logged and reported, never thrown at the caller.
 */
export function recordAiAction(
  context: string | null,
  entry: AiActionEntry,
  deps: AiActionLedgerDeps = defaultDeps,
): Promise<AiActionRecordResult> {
  return enqueue(async () => {
    const describe = `${entry.kind} ${entry.target.kind}/${entry.target.name}`;
    try {
      const next = appendAiAction(await deps.load(context), entry);
      const res = await deps.save(context, next);
      if (res.code !== 0) {
        const message = res.stderr.trim() || res.stdout.trim() || `kubectl exited ${res.code}`;
        deps.log(`rigel: could not record "${describe}" in the AI-action ledger: ${message}`);
        return { ok: false, message };
      }
      return { ok: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      deps.log(`rigel: could not record "${describe}" in the AI-action ledger: ${message}`);
      return { ok: false, message };
    }
  });
}
