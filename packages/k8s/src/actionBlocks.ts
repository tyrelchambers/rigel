// Shared action-block parsing — mirrors apps/server/src/claudeBridge.ts
// extractActionBlocks() and the Swift SuggestedAction.parse(). The chat panel
// (apps/web) and the server bridge both consume these, so the parsing lives
// once here. See docs/parity/contracts.md § 1 for the JSON schema.

import type { SuggestedAlert } from "./alerts";

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
  /** applyManifest only — the paired yaml content, attached by the parser (not in the model's JSON). */
  manifest?: string;
}

/**
 * QuestionField — an optional named free-text input attached to a question
 * option. The user's typed text maps to the AI's named variable (`name`), so the
 * model knows which slot was filled. See docs/parity/chat-input-fields.md § 2.
 */
export interface QuestionField {
  /** The AI's variable name. The user's typed text maps to it. Verbatim, no dedupe/trim. */
  name: string;
  /** Human label shown beside the field. Defaults to `name` at render time. */
  label?: string;
  /** Example/hint text inside the input. */
  placeholder?: string;
  /** Defaults to true. Submit is gated until every required field is non-empty. */
  required?: boolean;
}

/**
 * SuggestedQuestion — the fenced ```question JSON Claude emits to ask the user
 * to choose between options. The app renders the prompt + one button per option;
 * the picked `value` (or `label`) is sent back as the user's next message.
 *
 * Each option may carry an optional `fields` array (free-text inputs). An option
 * with surviving fields renders as a mini-form; a fieldless option is today's
 * instant-send button. See docs/parity/chat-input-fields.md.
 */
export interface SuggestedQuestion {
  question: string;
  options: { label: string; value?: string; fields?: QuestionField[] }[];
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
  "applyManifest",
] as const;

/**
 * Action kinds that are ALWAYS destructive regardless of the model's hint.
 * Mirrors the Swift destructive detection (delete/drain/purge family).
 */
const ALWAYS_DESTRUCTIVE_KINDS = new Set<string>([
  "deletePod",
  "deleteWorkload",
  "deleteNamespace",
  "deleteResource",
  "drain",
  "purge",
]);

/**
 * Whether an action should render/confirm with the destructive (red) treatment.
 * True when the model flagged it (`destructive === true`) OR the kind is in the
 * always-destructive family. The model's `false` can never downgrade an
 * inherently destructive kind (we take the stricter of the two).
 */
export function isDestructiveAction(action: Pick<SuggestedAction, "kind" | "destructive">): boolean {
  return action.destructive === true || ALWAYS_DESTRUCTIVE_KINDS.has(action.kind);
}

/**
 * Extract fenced action blocks from markdown.
 * Mirrors apps/server/src/claudeBridge.ts extractActionBlocks().
 * Malformed JSON blocks are skipped. For `applyManifest` actions, the
 * immediately-following yaml block is consumed and attached as `manifest`;
 * if no yaml block follows, the action is dropped (incomplete).
 */
export function extractActionBlocks(markdown: string): SuggestedAction[] {
  const out: SuggestedAction[] = [];
  const ACTION_FENCE = /```action\s*\n([\s\S]*?)\n```/g;
  const YAML_FENCE = /^\s*```ya?ml\s*\n([\s\S]*?)\n```/;
  let m: RegExpExecArray | null;
  while ((m = ACTION_FENCE.exec(markdown))) {
    let action: SuggestedAction | null = null;
    try {
      const json = JSON.parse(m[1].trim());
      if (json && typeof json.label === "string" && typeof json.kind === "string") {
        action = json as SuggestedAction;
      }
    } catch {
      /* skip malformed JSON */
    }
    if (!action) continue;
    if (action.kind === "applyManifest") {
      const ym = YAML_FENCE.exec(markdown.slice(ACTION_FENCE.lastIndex));
      if (!ym) continue; // incomplete — drop
      action.manifest = ym[1];
    }
    out.push(action);
  }
  return out;
}

/**
 * Remove action and question blocks from markdown for display. Other code
 * fences (bash, yaml, …) are left intact, UNLESS the yaml immediately follows
 * an `applyManifest` action block (in which case both are stripped together).
 */
export function stripActionBlocks(markdown: string): string {
  const ACTION_WITH_OPT_YAML = /```action\s*\n([\s\S]*?)\n```(\s*\n```ya?ml\s*\n[\s\S]*?\n```)?/g;
  let out = markdown.replace(
    ACTION_WITH_OPT_YAML,
    (_full, body: string, yamlTail: string | undefined) => {
      try {
        const json = JSON.parse(String(body).trim());
        if (json?.kind === "applyManifest") return ""; // drop action + paired yaml
      } catch { /* fall through */ }
      return yamlTail ?? ""; // non-applyManifest: keep any following yaml
    },
  );
  out = out
    .replace(/```question\s*\n[\s\S]*?\n```/g, "")
    .replace(/```alert\s*\n[\s\S]*?\n```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return out;
}

/**
 * Validate + filter one option's `fields` array per the contract (§ 2):
 * `fields` must be an array; each entry is kept only if it's an object with a
 * string `name`. Per field, `label`/`placeholder` are kept only when strings;
 * `required` is kept only when boolean, else defaults to `true`. Returns the
 * surviving fields, or `undefined` when `fields` is absent, non-array, or every
 * field was dropped — `undefined` degrades the option to a plain instant-send
 * button (never an empty form).
 */
function parseQuestionFields(raw: unknown): QuestionField[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const fields: QuestionField[] = [];
  for (const f of raw) {
    if (!f || typeof f !== "object") continue;
    const obj = f as { name?: unknown; label?: unknown; placeholder?: unknown; required?: unknown };
    if (typeof obj.name !== "string") continue;
    fields.push({
      name: obj.name,
      label: typeof obj.label === "string" ? obj.label : undefined,
      placeholder: typeof obj.placeholder === "string" ? obj.placeholder : undefined,
      required: typeof obj.required === "boolean" ? obj.required : true,
    });
  }
  return fields.length > 0 ? fields : undefined;
}

/** Extract fenced question blocks. Malformed/empty ones are skipped. */
export function extractQuestionBlocks(markdown: string): SuggestedQuestion[] {
  const out: SuggestedQuestion[] = [];
  for (const m of markdown.matchAll(/```question\s*\n([\s\S]*?)\n```/g)) {
    try {
      const json = JSON.parse(m[1]!.trim());
      if (json && typeof json.question === "string" && Array.isArray(json.options)) {
        const options = json.options
          .filter((o: unknown): o is { label: string; value?: unknown; fields?: unknown } =>
            !!o && typeof (o as { label?: unknown }).label === "string")
          .map((o: { label: string; value?: unknown; fields?: unknown }) => ({
            label: o.label,
            value: typeof o.value === "string" ? o.value : undefined,
            fields: parseQuestionFields(o.fields),
          }));
        if (options.length > 0) out.push({ question: json.question, options });
      }
    } catch {
      /* skip malformed JSON */
    }
  }
  return out;
}

/** Extract fenced ```alert blocks. Malformed/incomplete ones are skipped. */
export function extractAlertBlocks(markdown: string): SuggestedAlert[] {
  const out: SuggestedAlert[] = [];
  for (const m of markdown.matchAll(/```alert\s*\n([\s\S]*?)\n```/g)) {
    try {
      const json = JSON.parse(m[1]!.trim());
      if (
        json && typeof json.label === "string" && typeof json.text === "string" &&
        json.target && typeof json.target === "object" &&
        json.condition && typeof json.condition === "object"
      ) {
        out.push(json as SuggestedAlert);
      }
    } catch {
      /* skip malformed JSON */
    }
  }
  return out;
}

/**
 * buildQuestionAnswer — the SINGLE source of truth for the message string sent
 * back to the AI when the user answers a ```question block (web; the Swift twin
 * in ClarifyingQuestion.swift produces byte-identical output). See § 3.
 *
 *   > {question}
 *   {option.value ?? option.label}
 *   {field.name}: {value}   ← one line per field WITH a value, in field order
 *
 * A field whose value is blank/whitespace-only is omitted (this is how empty
 * optionals disappear). Values are inserted verbatim (no escaping). For a
 * fieldless option (or empty `values`) the output is byte-identical to today's
 * `> question\n value ?? label`.
 */
export function buildQuestionAnswer(
  question: string,
  option: { label: string; value?: string; fields?: QuestionField[] },
  values: Record<string, string>,
): string {
  const lines = [`> ${question}`, option.value ?? option.label];
  for (const field of option.fields ?? []) {
    const value = values[field.name];
    if (value != null && value.trim() !== "") lines.push(`${field.name}: ${value}`);
  }
  return lines.join("\n");
}

/**
 * SuggestedAction.parse — split an assistant message into displayable markdown,
 * the extracted action blocks, question blocks, and alert blocks. Mirrors the
 * Swift parse() that returns (display, actions[], questions[]).
 */
export function parseSuggestedActions(text: string): {
  display: string;
  actions: SuggestedAction[];
  questions: SuggestedQuestion[];
  alerts: SuggestedAlert[];
} {
  return {
    display: stripActionBlocks(text),
    actions: extractActionBlocks(text),
    questions: extractQuestionBlocks(text),
    alerts: extractAlertBlocks(text),
  };
}
