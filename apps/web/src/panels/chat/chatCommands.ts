/**
 * Chat slash-command registry — drives the `/` typeahead popover. Mirrors the
 * Swift `ChatCommandRegistry`.
 */
export interface ChatCommandSpec {
  name: string;
  aliases: string[];
  description: string;
  argHint?: string;
}

export const CHAT_COMMANDS: ChatCommandSpec[] = [
  { name: "help", aliases: ["?"], description: "Show available commands" },
  { name: "clear", aliases: [], description: "Clear the visible chat history" },
  { name: "investigate", aliases: [], description: "Audit cluster health" },
  { name: "logs", aliases: ["tail"], description: "Open the Logs tab tailing a deployment", argHint: "<deployment>" },
  { name: "restart", aliases: [], description: "Rollout-restart a deployment", argHint: "<deployment>" },
  { name: "describe", aliases: [], description: "Paste a kubectl describe into chat", argHint: "<pod|deployment>" },
];

/** "/logs <deployment>" — display string for the popover. */
export function commandDisplay(s: ChatCommandSpec): string {
  return `/${s.name}${s.argHint ? ` ${s.argHint}` : ""}`;
}

/** Text inserted into the composer when a command is picked. */
export function commandInsertion(s: ChatCommandSpec): string {
  return `/${s.name} `;
}

/**
 * Commands matching the partial typed after the leading slash (empty → all).
 * Ranks exact/prefix name matches above alias and description matches.
 */
export function filterCommands(query: string): ChatCommandSpec[] {
  const q = query.toLowerCase();
  if (!q) return CHAT_COMMANDS;
  const ranked = CHAT_COMMANDS.flatMap((s) => {
    let r: number | null = null;
    if (s.name === q) r = 0;
    else if (s.name.startsWith(q)) r = 1;
    else if (s.aliases.some((a) => a.startsWith(q))) r = 2;
    else if (s.description.toLowerCase().includes(q)) r = 3;
    return r === null ? [] : [{ r, s }];
  });
  return ranked.sort((a, b) => a.r - b.r).map((x) => x.s);
}
