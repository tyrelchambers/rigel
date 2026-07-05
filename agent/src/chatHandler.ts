import { parseActions, type SuggestedAction } from "./action.js";

/** Strip closed ```action fences from a reply so the operator sees prose only. */
export function stripActionFences(text: string): string {
  return text.replace(/```action[\s\S]*?```/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Route an act-capable chat reply: if it proposes a (destructive) command
 *  action, queue it via `enqueue` (returns the 1-based queue index) and append a
 *  confirm line. Otherwise return the prose reply unchanged. */
export async function routeChatReply(
  text: string,
  enqueue: (action: SuggestedAction) => Promise<number>,
): Promise<string> {
  const actions = parseActions(text);
  const prose = stripActionFences(text) || "Done.";
  if (actions.length === 0) return prose;
  const first = actions[0]!;
  const index = await enqueue(first);
  return `${prose}\n\nReply "yes" to run it (or "approve ${index}").`;
}
