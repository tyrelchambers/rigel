/**
 * Pure helpers that let the inbound chat agent see and act on the fixes the
 * autonomous loop has queued for the operator's approval. `pendingFixesContext`
 * renders a compact block injected ahead of the operator's message so the agent
 * knows what's pending; `sameInvocations` correlates an action the agent emits
 * back to a queued item so running it from chat clears that item from the queue.
 */
import { isRepoFixAction, toKubectlInvocations, type SuggestedAction } from "./action.js";
import type { QueuedSuggestion } from "./state.js";

/** The kubectl invocations an action runs, or null when it has none (a repo-fix
 *  opens a PR; a malformed action can't be rendered). */
function invocations(action: SuggestedAction): string[][] | null {
  if (isRepoFixAction(action.kind)) return null;
  try {
    return toKubectlInvocations(action);
  } catch {
    return null;
  }
}

/** Do two actions run the exact same kubectl command(s)? Repo-fix / unrenderable
 *  actions never match. Used to link an emitted action to a queued item. */
export function sameInvocations(a: SuggestedAction, b: SuggestedAction): boolean {
  const ia = invocations(a);
  const ib = invocations(b);
  if (!ia || !ib) return false;
  return JSON.stringify(ia) === JSON.stringify(ib);
}

/** A bracketed context block listing the queued fixes, or "" when none. Injected
 *  ahead of the operator's message; the system prompt tells the agent how to use
 *  it (act only when referred to; run one by emitting its command action). */
export function pendingFixesContext(queue: QueuedSuggestion[]): string {
  if (queue.length === 0) return "";
  const lines = queue.slice(0, 10).map((q, i) => {
    const inv = q.action ? invocations(q.action) : null;
    let how: string;
    if (inv) how = `run: ${inv.map((args) => "kubectl " + args.join(" ")).join(" && ")}`;
    else if (q.action && isRepoFixAction(q.action.kind)) how = "opens a fix PR (handled by the fix-runner, not from chat)";
    else how = "handle in Rigel (not runnable from chat)";
    return `${i + 1}. ${q.suggestion} — ${how}`;
  });
  return [
    "[Context — fixes the background agent has queued for your approval. Don't raise these unprompted; act only if the operator refers to one.",
    'To run one they approve, emit its ```action block as {"kind":"command","args":[…the kubectl args without the binary…]} — even when reversible — so it runs through the guard and clears from their queue.',
    ...lines,
    "]",
  ].join("\n");
}
