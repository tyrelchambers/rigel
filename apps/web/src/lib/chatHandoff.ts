/**
 * Global chat handoff — lets any panel inject a prompt into the always-mounted
 * ChatPane without prop-drilling. `newThread` starts a fresh conversation and
 * reveals the pane (via the App-registered reveal hook) before sending.
 */
export interface ChatHandoffOpts {
  /** Start a brand-new chat thread (prior conversation stays saved) + reveal the pane. */
  newThread?: boolean;
}

let handler: ((prompt: string, opts?: ChatHandoffOpts) => void) | null = null;
let reveal: (() => void) | null = null;

export function registerChatHandoff(fn: (prompt: string, opts?: ChatHandoffOpts) => void): void {
  handler = fn;
}

/** App registers this so a new-thread handoff can un-hide a collapsed chat pane. */
export function registerChatReveal(fn: () => void): void {
  reveal = fn;
}

export function handoffToChat(prompt: string, opts?: ChatHandoffOpts): void {
  if (opts?.newThread) reveal?.();
  handler?.(prompt, opts);
}
