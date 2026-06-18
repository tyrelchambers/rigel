/**
 * Pure typeahead logic for the chat composer (PaneComposer). Extracted from
 * the inline `useMemo` so it can be unit-tested without React.
 *
 * Two triggers, matched against the text up to the caret:
 * - a leading "/" (with no whitespace before the caret) → command popover
 * - an "@<token>" preceded by start-of-string or whitespace → mention popover
 */
import { filterCommands, type ChatCommandSpec } from "@/panels/chat/chatCommands";
import { filterMentions, type MentionCandidate } from "@/panels/chat/mentions";

export type ComposerTrigger =
  | { kind: "command"; query: string; items: ChatCommandSpec[] }
  | { kind: "mention"; query: string; start: number; items: MentionCandidate[] };

/**
 * Compute the active "/" (leading) or "@<token>" trigger from the text up to
 * the caret. Returns null when neither trigger is active or no items match.
 */
export function computeTrigger(
  value: string,
  caret: number,
  mentionCandidates: MentionCandidate[],
): ComposerTrigger | null {
  const before = value.slice(0, caret);
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
      const items = filterMentions(mentionCandidates, frag);
      return items.length ? { kind: "mention", query: frag, start: at, items } : null;
    }
  }
  return null;
}

/**
 * The argument text that follows the command word — everything after the first
 * space in the composer value (empty when there is no space).
 */
export function commandRest(value: string): string {
  const sp = value.indexOf(" ");
  return sp >= 0 ? value.slice(sp + 1) : "";
}
