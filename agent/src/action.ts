/**
 * The action contract shared verbatim with Rigel's Swift
 * `SuggestedAction` (Sources/Rigel/Chat/SuggestedAction.swift). The worker
 * proposes a remediation by emitting one or more fenced ```action JSON blocks;
 * we parse them here and map them to kubectl invocations that match
 * `WorkloadAction.kubectlInvocations()` exactly, so the agent and the app run
 * identical commands.
 */
export interface SuggestedAction {
  label: string;
  kind: string;
  deployment?: string;
  pod?: string;
  node?: string;
  namespace?: string;
  replicas?: number;
  env?: Record<string, string>;
  /** `openFixPR` only — the workload's GitOps source/deployment name (from its
   * annotation) that the fix PR is opened against. */
  source?: string;
  /** `openFixPR` only — repo-relative path of the file to write. */
  filePath?: string;
  /** `openFixPR` only — full new contents for `filePath`. */
  content?: string;
  /** `openFixPR` only — pull-request title. */
  title?: string;
  /** `openFixPR` only — pull-request body. */
  body?: string;
}

/**
 * Kinds that are NOT kubectl mutations: instead of touching the cluster they open
 * a fix PR against the workload's GitOps source, executed by the fix-runner (a
 * Job) in a later task — never through `toKubectlInvocations`. The executor/caller
 * branches on this so an `openFixPR` can never be mistaken for a kubectl command.
 */
const REPO_FIX_KINDS: ReadonlySet<string> = new Set(["openFixPR"]);

export function isRepoFixAction(kind: string): boolean {
  return REPO_FIX_KINDS.has(kind);
}

/**
 * Split assistant text and decode every closed ```action fence into actions.
 * Mirrors `SuggestedAction.parse`: odd-indexed segments (between ``` markers)
 * are "inside a fence"; a trailing unterminated action fence is dropped so a
 * half-streamed JSON object never decodes. Non-action fences are ignored.
 */
export function parseActions(text: string): SuggestedAction[] {
  if (!text.includes("```")) return [];
  const parts = text.split("```");
  const actions: SuggestedAction[] = [];
  for (let i = 0; i < parts.length; i++) {
    const insideFence = i % 2 === 1;
    if (!insideFence) continue;
    const isClosed = i < parts.length - 1;
    const part = parts[i] ?? "";
    const nl = part.indexOf("\n");
    const lang = (nl === -1 ? part : part.slice(0, nl)).trim().toLowerCase();
    if (lang !== "action" || !isClosed) continue;
    const body = nl === -1 ? "" : part.slice(nl + 1);
    actions.push(...decode(body));
  }
  return actions;
}

function decode(json: string): SuggestedAction[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return arr.filter((a): a is SuggestedAction => isAction(a));
}

function isAction(a: unknown): a is SuggestedAction {
  return (
    typeof a === "object" &&
    a !== null &&
    typeof (a as Record<string, unknown>).label === "string" &&
    typeof (a as Record<string, unknown>).kind === "string"
  );
}

/**
 * Map an action to the sequence of kubectl arg-vectors to run (no `kubectl`
 * prefix, no `--context`/`--namespace` injected by the caller's wrapper here —
 * namespace is baked in as `-n` to mirror the Swift command surface). Throws on
 * a missing required target or an unsupported kind, so a malformed proposal
 * fails loudly rather than running a wrong command.
 */
export function toKubectlInvocations(action: SuggestedAction): string[][] {
  const ns = action.namespace ?? "default";
  switch (action.kind) {
    case "restart":
      return [["rollout", "restart", `deployment/${need(action.deployment, "deployment")}`, "-n", ns]];
    case "rollback":
      return [["rollout", "undo", `deployment/${need(action.deployment, "deployment")}`, "-n", ns]];
    case "scale":
      return [
        ["scale", `deployment/${need(action.deployment, "deployment")}`, `--replicas=${need(action.replicas, "replicas")}`, "-n", ns],
      ];
    case "setEnv": {
      const env = need(action.env, "env");
      const pairs = Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .sort();
      return [["set", "env", `deployment/${need(action.deployment, "deployment")}`, "-n", ns, ...pairs]];
    }
    case "deletePod":
      return [["delete", "pod", need(action.pod, "pod"), "-n", ns]];
    case "cordon":
      return [["cordon", need(action.node, "node")]];
    case "uncordon":
      return [["uncordon", need(action.node, "node")]];
    case "openFixPR":
      // Not a kubectl action — opening a PR against the GitOps source is the
      // fix-runner's job. Fail loudly here so it can never silently run a command.
      throw new Error("openFixPR is not a kubectl action (handled by the fix-runner)");
    default:
      throw new Error(`unsupported action kind: ${action.kind}`);
  }
}

export interface BackupTarget {
  kind: string;
  name: string;
  namespace: string | null;
}

/** The resource to snapshot (`kubectl get -o yaml`) before a mutation, enabling
 * one-click revert. Throws on an unsupported kind so we never mutate without
 * knowing what to back up. */
export function backupTarget(action: SuggestedAction): BackupTarget {
  const ns = action.namespace ?? "default";
  switch (action.kind) {
    case "restart":
    case "scale":
    case "setEnv":
    case "rollback":
      return { kind: "deployment", name: need(action.deployment, "deployment"), namespace: ns };
    case "deletePod":
      return { kind: "pod", name: need(action.pod, "pod"), namespace: ns };
    case "cordon":
    case "uncordon":
      return { kind: "node", name: need(action.node, "node"), namespace: null };
    case "openFixPR":
      // No cluster resource to snapshot — the fix-runner opens a PR; reverting is
      // a git operation, not a `kubectl apply` of a backup.
      throw new Error("openFixPR has no kubectl backup target (handled by the fix-runner)");
    default:
      throw new Error(`unsupported action kind: ${action.kind}`);
  }
}

function need<T>(value: T | undefined, field: string): T {
  if (value === undefined || value === null || value === "") {
    throw new Error(`action is missing required field: ${field}`);
  }
  return value;
}
