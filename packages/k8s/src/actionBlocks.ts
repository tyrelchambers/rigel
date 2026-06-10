// Shared action-block parsing — mirrors apps/server/src/claudeBridge.ts
// extractActionBlocks() and the Swift SuggestedAction.parse(). The chat panel
// (apps/web) and the server bridge both consume these, so the parsing lives
// once here. See docs/parity/contracts.md § 1 for the JSON schema.

/**
 * SuggestedAction — the fenced ```action JSON Claude emits for any cluster
 * mutation. The app hides the raw block and renders a one-click button that
 * opens the confirm sheet. Do NOT invent new `kind` values.
 */
export interface SuggestedAction {
  /** Button text. */
  label: string;
  /** Action kind — see ACTION_KINDS. */
  kind: string;
  /** Controller / cronjob / namespace / resource target. */
  name?: string;
  /** Back-compat alias for `name` (target = name ?? deployment). */
  deployment?: string;
  pod?: string;
  node?: string;
  namespace?: string;
  /** scale */
  replicas?: number;
  /** setEnv */
  env?: Record<string, string>;
  /** setImage / setResources */
  container?: string;
  /** setImage */
  image?: string;
  /** setResources — kubectl quantity strings, e.g. "cpu=250m,memory=512Mi". */
  requests?: string;
  limits?: string;
  /** deleteResource — e.g. "service", "configmap", "secret", "pvc", "ingress". */
  resourceKind?: string;
  /** command — literal kubectl args WITHOUT the binary or --context. */
  args?: string[];
  /** command — Claude's destructive hint (app takes the stricter of this and inference). */
  destructive?: boolean;
}

/** Valid action kinds (docs/parity/contracts.md § 1). */
export const ACTION_KINDS = [
  "restart",
  "scale",
  "rollback",
  "setEnv",
  "setImage",
  "setResources",
  "pause",
  "resume",
  "deletePod",
  "deleteWorkload",
  "cordon",
  "uncordon",
  "drain",
  "suspendCronJob",
  "resumeCronJob",
  "triggerCronJob",
  "createNamespace",
  "deleteNamespace",
  "deleteResource",
  "purge",
  "command",
] as const;

/**
 * Extract fenced ```action blocks from markdown.
 * Mirrors apps/server/src/claudeBridge.ts extractActionBlocks().
 * Malformed JSON blocks are skipped.
 */
export function extractActionBlocks(markdown: string): SuggestedAction[] {
  const out: SuggestedAction[] = [];
  const re = /```action\s*\n([\s\S]*?)\n```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) {
    try {
      const json = JSON.parse(m[1].trim());
      if (json && typeof json.label === "string" && typeof json.kind === "string") {
        out.push(json as SuggestedAction);
      }
    } catch {
      /* skip malformed JSON */
    }
  }
  return out;
}

/**
 * Remove action and question blocks from markdown for display. Other code
 * fences (```bash, ```yaml, …) are left intact.
 */
export function stripActionBlocks(markdown: string): string {
  return markdown
    .replace(/```action\s*\n[\s\S]*?\n```/g, "")
    .replace(/```question\s*\n[\s\S]*?\n```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * SuggestedAction.parse — split an assistant message into displayable markdown
 * and the extracted action blocks. Mirrors the Swift parse() that returns
 * (display, actions[], questions[]). Questions are deferred (MVP).
 */
export function parseSuggestedActions(text: string): {
  display: string;
  actions: SuggestedAction[];
} {
  return { display: stripActionBlocks(text), actions: extractActionBlocks(text) };
}
