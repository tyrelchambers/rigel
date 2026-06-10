// A tiny registry so any panel can hand a prompt to the pinned chat pane
// without prop-drilling. ChatPane registers its send() on mount; panels call
// handoffToChat(prompt) — which appends the user message to the transcript AND
// streams the reply in the always-visible pane (no navigation, since chat is
// not a route).
let handler: ((prompt: string) => void) | null = null;

export function registerChatHandoff(fn: (prompt: string) => void): void {
  handler = fn;
}

export function handoffToChat(prompt: string): void {
  handler?.(prompt);
}
