/**
 * Global chat handoff — lets any panel inject a prompt into the always-mounted
 * ChatPane without prop-drilling. `newThread` starts a fresh conversation and
 * reveals the pane (via the App-registered reveal hook) before sending.
 */
export interface ChatHandoffOpts {
  /** Start a brand-new chat thread (prior conversation stays saved) + reveal the pane. */
  newThread?: boolean;
  /**
   * Friendly text to show in the user's chat bubble INSTEAD of the raw `prompt`.
   * The `prompt` is still what's sent to the model — use this when the prompt is
   * a machine directive (e.g. a `/skill-name` slash command) that reads poorly as
   * a message. Falls back to `prompt` when omitted.
   */
  displayText?: string;
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
