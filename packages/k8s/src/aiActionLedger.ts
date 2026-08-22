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
/** Longest `trigger` we persist; it carries a chat label or a voice utterance. */
export const AI_ACTION_TRIGGER_MAX = 200;
/** Longest `command` we persist. Long enough to keep a real kubectl invocation
 *  intact, short enough that the ring buffer cannot outgrow a ConfigMap. */
export const AI_ACTION_COMMAND_MAX = 1000;
/**
 * Byte budget for the serialized entry array. A ConfigMap caps near 1MiB, and
 * `kubectl apply` stores the whole manifest a second time in its
 * last-applied-configuration annotation, so the usable share is well under half.
 */
export const AI_ACTIONS_MAX_BYTES = 256 * 1024;

/** Appended in place of the cut text so a reader never mistakes a truncated
 *  value for the whole one. */
export const AI_ACTION_TRUNCATED_MARKER = "... [truncated]";

/** Cut `value` to `max` characters, spending the tail on a visible marker. */
export function truncateForLedger(value: string, max: number): string {
  if (value.length <= max) return value;
  const keep = Math.max(0, max - AI_ACTION_TRUNCATED_MARKER.length);
  return `${value.slice(0, keep)}${AI_ACTION_TRUNCATED_MARKER}`.slice(0, Math.max(max, 0));
}

/** Which AI surface ran the action. Both execute through the same server seams. */
export type AiActionSource = "chat" | "voice";

/**
 * "unsupported" is neither of the other two: nothing ran and nothing failed.
 * The operator asked for something the vocabulary cannot express, and that is
 * worth recording, because a gap nobody can see is one that gets rediscovered
 * one frustrating session at a time.
 */
export type AiActionOutcome = "success" | "failure" | "unsupported";

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
  unsupported: "Could not do",
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
  annotate: "Annotated",
  label: "Labelled",
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
    command: truncateForLedger(input.command, AI_ACTION_COMMAND_MAX),
    outcome: input.outcome,
  };
  const trigger = trimmed(input.trigger) ?? trimmed(input.action.label);
  if (trigger) entry.trigger = truncateForLedger(trigger, AI_ACTION_TRIGGER_MAX);
  const detail = trimmed(input.detail);
  if (detail) entry.detail = truncateForLedger(detail, AI_ACTION_DETAIL_MAX);
  return entry;
}

/**
 * Prepend an entry and truncate to the ring-buffer cap, then drop further
 * oldest entries until the serialized list fits `maxBytes`. Never mutates
 * `list`, and never throws: a ledger that refuses every write from here on is
 * worse than one that has forgotten its oldest entries.
 */
export function appendAiAction(
  list: AiActionEntry[],
  entry: AiActionEntry,
  max: number = AI_ACTIONS_MAX,
  maxBytes: number = AI_ACTIONS_MAX_BYTES,
): AiActionEntry[] {
  const next = [entry, ...list].slice(0, max);
  while (next.length > 1 && serializedBytes(next) > maxBytes) next.pop();
  return next;
}

const serializedBytes = (entries: AiActionEntry[]): number => {
  try {
    return new TextEncoder().encode(JSON.stringify(entries)).length;
  } catch {
    return 0;
  }
};

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
  return line ? truncateForLedger(line, AI_ACTION_DETAIL_MAX) : undefined;
}
