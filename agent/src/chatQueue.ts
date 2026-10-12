/**
 * Pure helpers that let the inbound chat agent see and act on the fixes the
 * autonomous loop has queued for the operator's approval. `pendingFixesContext`
 * renders a compact block injected ahead of the operator's message so the agent
 * knows what's pending; `sameAction` correlates an action the agent emits back to
 * a queued item so running it from chat clears that item from the queue.
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

/** Do two actions do the same thing? Kubectl actions match on the exact
 *  command(s) they run; fix PRs match on their GitOps source and file.
 *  Unrenderable actions never match. Used to link an emitted action to a queued item. */
export function sameAction(a: SuggestedAction, b: SuggestedAction): boolean {
  if (isRepoFixAction(a.kind) || isRepoFixAction(b.kind)) {
    return a.kind === b.kind && !!a.filePath && a.filePath === b.filePath && a.source === b.source;
  }
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
    else if (q.action && isRepoFixAction(q.action.kind)) {
      const { kind, label, source, filePath } = q.action;
      how = `opens a fix PR; to approve, emit: ${JSON.stringify({ kind, label, source, filePath })}`;
    } else how = "handle in Rigel (not runnable from chat)";
    return `${i + 1}. ${q.suggestion} — ${how}`;
  });
  return [
    "[Context — fixes the background agent has queued for your approval. Don't raise these unprompted; act only if the operator refers to one.",
    'To run one they approve, emit its ```action block: a kubectl fix as {"kind":"command","args":[…the kubectl args without the binary…]} — even when reversible — and a fix PR as the openFixPR object shown, so it runs through the guard and clears from their queue.',
    ...lines,
    "]",
  ].join("\n");
}
