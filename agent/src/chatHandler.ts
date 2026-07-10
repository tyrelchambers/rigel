import { parseActions, type SuggestedAction } from "./action.js";

/** Strip closed ```action fences from a reply so the operator sees prose only. */
export function stripActionFences(text: string): string {
  return text.replace(/```action[\s\S]*?```/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Route an act-capable chat reply. The agent emits an ```action block only once
 *  the operator has confirmed a destructive change (reversible ones it just runs
 *  inline), so a block here means "run it now": execute it through the guard and
 *  append the outcome. A reply with no block is prose the operator sees as-is. */
export async function routeChatReply(
  text: string,
  execute: (action: SuggestedAction) => Promise<string>,
): Promise<string> {
  const actions = parseActions(text);
  const prose = stripActionFences(text);
  if (actions.length === 0) return prose || "Done.";
  const outcome = await execute(actions[0]!);
  return prose ? `${prose}\n\n${outcome}` : outcome;
}
