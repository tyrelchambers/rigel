/**
 * Pure typeahead logic for the chat composer (PaneComposer). Extracted from
 * the inline `useMemo` so it can be unit-tested without React.
 *
 * Triggers, matched against the text up to the caret (first match wins):
 * - `/describe ` (a space after the command) → progressive resource picker
 *   (type → namespace → instance). Checked first, since the trailing space means
 *   the generic command branch no longer matches.
 * - a leading "/" (with no whitespace before the caret) → command popover
 * - an "@<token>" preceded by start-of-string or whitespace → mention popover
 */
import { filterCommands, type ChatCommandSpec } from "@/panels/chat/chatCommands";
import { filterMentions, type MentionCandidate } from "@/panels/chat/mentions";
import {
  describeTypeOptions,
  describeNamespaceOptions,
  describeInstanceOptions,
  resolveDescribeKind,
  type DescribeKind,
  type DescribeOption,
} from "@/panels/chat/describeResources";

export type DescribeStage = "type" | "namespace" | "instance";

export type ComposerTrigger =
  | { kind: "command"; query: string; items: ChatCommandSpec[] }
  | { kind: "mention"; query: string; start: number; items: MentionCandidate[] }
  | {
      kind: "describe";
      stage: DescribeStage;
      query: string;
      /** Index in the value where the current partial token begins. */
      start: number;
      items: DescribeOption[];
      /** Resolved kind for the namespace + instance stages. */
      resourceKind?: DescribeKind;
      /** Instance stage: resolved namespace (undefined = cluster-scoped). */
      namespace?: string;
    };

/** Live data the describe picker needs to build its stage options. */
export interface ComposerTriggerContext {
  mentionCandidates: MentionCandidate[];
  resources: Record<string, unknown>;
  /** Active namespace filter; null = All namespaces. */
  namespaceFilter: string | null;
}

/**
 * Compute the active trigger from the text up to the caret. Returns null when no
 * trigger is active or (for the command/mention/type stages) nothing matches.
 * The describe namespace/instance stages intentionally return even with zero
 * items so the popover can show a "no results" state.
 */
export function computeTrigger(
  value: string,
  caret: number,
  ctx: ComposerTriggerContext,
): ComposerTrigger | null {
  const before = value.slice(0, caret);

  const describe = computeDescribeTrigger(before, caret, ctx);
  if (describe) return describe;

  if (value.startsWith("/") && !/\s/.test(before)) {
    const query = before.slice(1);
    const items = filterCommands(query);
    return items.length ? { kind: "command", query, items } : null;
  }
  const at = before.lastIndexOf("@");
  if (at >= 0) {
    const prevOk = at === 0 || /\s/.test(before[at - 1]);
    const frag = before.slice(at + 1);
    if (prevOk && !/\s/.test(frag)) {
      const items = filterMentions(ctx.mentionCandidates, frag);
      return items.length ? { kind: "mention", query: frag, start: at, items } : null;
    }
  }
  return null;
}

/**
 * Parse `/describe <type> [-n <ns>] [<namePartial>]` from the text up to the
 * caret and resolve which stage is active. Returns null when the text isn't a
 * `/describe ` continuation or the type isn't in the curated set (graceful
 * fallback: the raw text passes through to the agent).
 */
function computeDescribeTrigger(
  before: string,
  caret: number,
  ctx: ComposerTriggerContext,
): ComposerTrigger | null {
  const m = before.match(/^\/describe[ \t]+(.*)$/);
  if (!m) return null;
  const rest = m[1];
  const tokens = rest.length ? rest.split(/\s+/) : [""];
  const partial = tokens[tokens.length - 1] ?? "";
  const completed = tokens.slice(0, -1);
  const start = caret - partial.length;

  // Type stage — no complete type token yet.
  if (completed.length === 0) {
    const items = describeTypeOptions(partial);
    return items.length ? { kind: "describe", stage: "type", query: partial, start, items } : null;
  }

  const k = resolveDescribeKind(completed[0]);
  if (!k) return null; // unknown type → fall through to the agent

  // Cluster-scoped kinds skip the namespace step.
  if (k.scope === "cluster") {
    const items = describeInstanceOptions(ctx.resources, k, undefined, partial);
    return { kind: "describe", stage: "instance", query: partial, start, items, resourceKind: k };
  }

  // Namespaced: explicit `-n <ns>` wins, else the active filter. When the filter
  // is All and no `-n` is present, the namespace must be chosen first.
  const ns = explicitNamespace(completed) ?? ctx.namespaceFilter ?? undefined;
  if (ns === undefined) {
    const items = describeNamespaceOptions(ctx.resources, partial);
    return { kind: "describe", stage: "namespace", query: partial, start, items, resourceKind: k };
  }
  const items = describeInstanceOptions(ctx.resources, k, ns, partial);
  return { kind: "describe", stage: "instance", query: partial, start, items, resourceKind: k, namespace: ns };
}

/**
 * The text a /describe selection writes into the composer (the part before the
 * caret). Each stage rebuilds the command canonically from the parsed trigger so
 * the result is identical regardless of which path produced it.
 */
export function describeInsertion(
  trigger: Extract<ComposerTrigger, { kind: "describe" }>,
  opt: DescribeOption,
): string {
  if (trigger.stage === "type") return `/describe ${opt.value} `;
  const singular = trigger.resourceKind?.singular ?? "";
  if (trigger.stage === "namespace") return `/describe ${singular} -n ${opt.value} `;
  return trigger.namespace === undefined
    ? `/describe ${singular} ${opt.value}`
    : `/describe ${singular} ${opt.value} -n ${trigger.namespace}`;
}

/** Pull the value of a completed `-n` / `--namespace` flag, if present. */
function explicitNamespace(completed: string[]): string | undefined {
  for (const flag of ["-n", "--namespace"]) {
    const i = completed.lastIndexOf(flag);
    if (i >= 0 && i + 1 < completed.length) return completed[i + 1];
  }
  return undefined;
}

/**
 * The argument text that follows the command word — everything after the first
 * space in the composer value (empty when there is no space).
 */
export function commandRest(value: string): string {
  const sp = value.indexOf(" ");
  return sp >= 0 ? value.slice(sp + 1) : "";
}
