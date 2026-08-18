// The AI-action audit ledger (HELM-18): every cluster mutation Rigel's chat and
// voice surfaces perform, recorded durably so it outlives Kubernetes's ~1h Event
// TTL. Stored as a newest-first, capped JSON array in the server-owned
// `rigel-chat-actions` ConfigMap. Pure helpers only (no process spawning);
// apps/server/src/aiActionLedger.ts owns the serialized read-modify-write.
//
// The agent surface keeps its own richer ledger in `assistant-state`; these two
// stores stay separate and are merged at the presentation layer.

import { LEDGER_LABEL_KEY } from "./applyBatch";

export const AI_ACTIONS_CONFIGMAP = "rigel-chat-actions";
export const AI_ACTIONS_DATA_KEY = "log.json";
export const AI_ACTIONS_LABEL_VALUE = "ai-actions";
/** Ring-buffer size. Oldest entries fall off the end. */
export const AI_ACTIONS_MAX = 200;
/** Longest `detail` we persist; a ConfigMap is not a log store. */
export const AI_ACTION_DETAIL_MAX = 200;

/** Which AI surface ran the action. Both execute through the same server seams. */
export type AiActionSource = "chat" | "voice";

export type AiActionOutcome = "success" | "failure";

export interface AiActionTarget {
  /** Resource kind as addressed, e.g. "Deployment", "Pod", "secret". */
  kind: string;
  name: string;
  /** Empty for cluster-scoped targets (nodes, namespaces). */
  namespace: string;
}

export interface AiActionEntry {
  id: string;
  at: string;
  source: AiActionSource;
  /** Past-tense action label, e.g. "Scaled", "Restarted", "Deleted". */
  kind: string;
  target: AiActionTarget;
  /** The exact command run, binary and flags included. */
  command: string;
  /** Originating intent, best-effort (the action button's label). */
  trigger?: string;
  outcome: AiActionOutcome;
  /** First line of the run's output, truncated. */
  detail?: string;
}

/** The action fields the ledger reads. Structurally satisfied by both
 *  `SuggestedAction` and the server's `ActionBlock`, so either can be passed. */
export interface AiActionSubject {
  kind: string;
  label?: string;
  name?: string;
  deployment?: string;
  pod?: string;
  node?: string;
  namespace?: string;
  resourceKind?: string;
}

export interface AiActionInput {
  action: AiActionSubject;
  source: AiActionSource;
  command: string;
  outcome: AiActionOutcome;
  trigger?: string;
  detail?: string;
  id?: string;
  at?: string;
}

/** Past-tense label per action kind (docs/parity/contracts.md § 1 kinds). */
const KIND_LABELS: Record<string, string> = {
  restart: "Restarted",
  rollback: "Rolled back",
  pause: "Paused",
  resume: "Resumed",
  scale: "Scaled",
  setEnv: "Env changed",
  setEnvRef: "Env changed",
  setImage: "Image changed",
  setImagePullSecrets: "Pull secrets changed",
  setResources: "Resources changed",
  deletePod: "Deleted",
  deleteWorkload: "Deleted",
  deleteResource: "Deleted",
  deleteNamespace: "Deleted",
  createNamespace: "Created",
  cordon: "Cordoned",
  uncordon: "Uncordoned",
  drain: "Drained",
  suspendCronJob: "Suspended",
  resumeCronJob: "Resumed",
  triggerCronJob: "Triggered",
  linkCatalogApp: "Linked",
  command: "Ran command",
  applyManifest: "Applied",
  proposeRepoFix: "Proposed fix",
};

const CLUSTER_SCOPED_DELETE_KINDS = new Set([
  "pv",
  "persistentvolume",
  "clusterrole",
  "clusterrolebinding",
]);

const targetName = (a: AiActionSubject): string => a.name ?? a.deployment ?? "";

function targetFor(a: AiActionSubject): AiActionTarget {
  const namespace = a.namespace ?? "default";
  switch (a.kind) {
    case "cordon":
    case "uncordon":
    case "drain":
      return { kind: "Node", name: a.node ?? "", namespace: "" };
    case "createNamespace":
    case "deleteNamespace":
      return { kind: "Namespace", name: targetName(a), namespace: "" };
    case "deletePod":
      return { kind: "Pod", name: a.pod ?? "", namespace };
    case "suspendCronJob":
    case "resumeCronJob":
    case "triggerCronJob":
      return { kind: "CronJob", name: targetName(a), namespace };
    case "deleteResource": {
      const kind = a.resourceKind ?? "";
      const scoped = CLUSTER_SCOPED_DELETE_KINDS.has(kind.toLowerCase());
      return { kind, name: targetName(a), namespace: scoped ? "" : namespace };
    }
    default:
      return { kind: a.resourceKind ?? "Deployment", name: targetName(a), namespace };
  }
}

const trimmed = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

/** Build the ledger entry for a command that has already run. */
export function buildAiActionEntry(input: AiActionInput): AiActionEntry {
  const entry: AiActionEntry = {
    id: input.id ?? crypto.randomUUID(),
    at: input.at ?? new Date().toISOString(),
    source: input.source,
    kind: KIND_LABELS[input.action.kind] ?? input.action.kind,
    target: targetFor(input.action),
    command: input.command,
    outcome: input.outcome,
  };
  const trigger = trimmed(input.trigger) ?? trimmed(input.action.label);
  if (trigger) entry.trigger = trigger;
  const detail = trimmed(input.detail);
  if (detail) entry.detail = detail.slice(0, AI_ACTION_DETAIL_MAX);
  return entry;
}

/** Prepend an entry and truncate to the ring-buffer cap. Never mutates `list`. */
export function appendAiAction(
  list: AiActionEntry[],
  entry: AiActionEntry,
  max: number = AI_ACTIONS_MAX,
): AiActionEntry[] {
  return [entry, ...list].slice(0, max);
}

/** Parse the ledger's JSON array (empty on missing/invalid input). */
export function parseAiActions(dataJSON: string | undefined | null): AiActionEntry[] {
  if (!dataJSON) return [];
  try {
    const parsed = JSON.parse(dataJSON);
    return Array.isArray(parsed) ? (parsed as AiActionEntry[]) : [];
  } catch {
    return [];
  }
}

/** Build the ledger ConfigMap manifest JSON. */
export function aiActionsConfigMapJSON(namespace: string, entries: AiActionEntry[]): string {
  return JSON.stringify({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: AI_ACTIONS_CONFIGMAP,
      namespace,
      labels: {
        [LEDGER_LABEL_KEY]: AI_ACTIONS_LABEL_VALUE,
        "app.kubernetes.io/managed-by": "rigel",
      },
    },
    data: { [AI_ACTIONS_DATA_KEY]: JSON.stringify(entries) },
  });
}

/**
 * One-line `detail` for a finished run: the first content line of the stream
 * that carries the explanation (stderr on failure, stdout on success), falling
 * back to the other stream when the preferred one is blank.
 */
export function summarizeActionDetail(
  outcome: AiActionOutcome,
  stdout: string,
  stderr: string,
): string | undefined {
  const firstLine = (s: string): string | undefined =>
    s.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  const preferred = outcome === "failure" ? stderr : stdout;
  const other = outcome === "failure" ? stdout : stderr;
  const line = firstLine(preferred) ?? firstLine(other);
  return line ? line.slice(0, AI_ACTION_DETAIL_MAX) : undefined;
}
