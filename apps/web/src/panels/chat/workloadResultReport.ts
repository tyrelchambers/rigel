// Builds the messages produced after a chat-proposed action runs (with the
// user's approval), mirroring Swift's WorkloadResultReport. This is what closes
// the loop: the model proposes → the user approves + Helmsman runs → the result
// returns to the SAME claude session so the model can verify and continue.
import type { ActionResult } from "@/lib/api";

/** Cap piped output so a chatty command can't blow the context window. */
const MAX_BODY = 4000;

function clip(s: string, fallback: string): string {
  const t = s.trim();
  if (t === "") return fallback;
  return t.length > MAX_BODY ? `${t.slice(0, MAX_BODY)}\n…(truncated)` : t;
}

/**
 * The hidden message fed back into the session (web analog of `display:false`).
 * `commandString` is the exact kubectl command the confirm sheet previewed.
 */
export function chatFeedback(commandString: string, result: ActionResult): string {
  if (result.code === 0) {
    return [
      "[Helmsman executed the action you proposed — the user approved it.]",
      "Command:",
      commandString,
      "Status: success",
      "Output:",
      clip(result.stdout, "(no output)"),
      "",
      "Continue the task: if this completes what the user asked, confirm briefly; otherwise proceed with the next step.",
    ].join("\n");
  }
  return [
    "[Helmsman ran the action you proposed — the user approved it — but it FAILED.]",
    "Command:",
    commandString,
    `Exit code: ${result.code}`,
    "Error:",
    clip(result.stderr, "(no stderr)"),
    "",
    "Diagnose the failure and propose a corrected next step.",
  ].join("\n");
}

/** Cap the visible system summary tighter than the model-facing feedback. */
const SUMMARY_CAP = 400;

function clipShort(s: string): string {
  const t = s.trim();
  return t.length > SUMMARY_CAP ? `${t.slice(0, SUMMARY_CAP)}…` : t;
}

/** The visible `✓`/`✗` system bubble shown in the transcript (Swift appendSystem). */
export function visibleSummary(title: string, result: ActionResult): string {
  if (result.code === 0) {
    const body = clipShort(result.stdout);
    return `✓ ${title} — ${body === "" ? "ok" : body}`;
  }
  return `✗ ${title} failed (exit ${result.code}):\n${clipShort(result.stderr)}`;
}
