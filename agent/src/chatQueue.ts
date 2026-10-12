/**
 * Pure helpers that let the inbound chat agent see and act on the fixes the
 * autonomous loop has queued for the operator's approval. `pendingFixesContext`
 * renders a compact block injected ahead of the operator's message so the agent
 * knows what's pending; `sameAction` correlates an action the agent emits back to
 * a queued item so running it from chat clears that item from the queue.
 */
import { isRepoFixAction, toKubectlInvocations, type SuggestedAction } from "./action.js";
import { isApprovable, type QueuedSuggestion } from "./state.js";

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

/** The JSON the agent emits to approve a queued action: the action itself, minus
 *  a fix PR's file content and body (bulky, and not used to match it). */
function approvalBlock(action: SuggestedAction): string {
  const { content: _content, body: _body, ...block } = action;
  return JSON.stringify(block);
}

/** A bracketed context block listing the queued fixes, or "" when none. Injected
 *  ahead of the operator's message; the system prompt tells the agent how to use
 *  it (act only when referred to; approve one by emitting the block shown). */
export function pendingFixesContext(queue: QueuedSuggestion[]): string {
  if (queue.length === 0) return "";
  const lines = queue.slice(0, 10).map((q, i) => {
    let how: string;
    if (q.pending) how = "fix PR already being opened, nothing to approve";
    else if (isApprovable(q) && (isRepoFixAction(q.action.kind) || invocations(q.action))) how = `to approve, emit: ${approvalBlock(q.action)}`;
    else how = "handle in Rigel (not runnable from chat)";
    return `${i + 1}. ${q.suggestion}: ${how}`;
  });
  return [
    "[Context — fixes the background agent has queued for your approval. Don't raise these unprompted; act only if the operator refers to one.",
    "To run one they approve, emit an ```action block with the exact JSON shown for it, unchanged, even when it's reversible, so it runs through the guard and clears from their queue.",
    ...lines,
    "]",
  ].join("\n");
}
