/**
 * The voice-tier execution gate. Deterministic on purpose: the LLM is never
 * asked whether it heard a confirmation. A mutation may only fire on the
 * standalone word "confirm", never on a bare affirmative, and any cancel token
 * wins over it. This is an execution gate, not an intent problem, so the repo's
 * prefer-the-LLM convention does not apply here.
 */
export type ConfirmVerdict = "confirm" | "cancel" | "other";

export const CANCEL_TOKENS = ["cancel", "stop", "wait", "abort", "no", "dont", "do not", "never mind"];

export function normalizeUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/['‘’]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchConfirmPhrase(text: string): ConfirmVerdict {
  const padded = ` ${normalizeUtterance(text)} `;
  if (CANCEL_TOKENS.some((t) => padded.includes(` ${t} `))) return "cancel";
  if (padded.includes(" confirm ")) return "confirm";
  return "other";
}
