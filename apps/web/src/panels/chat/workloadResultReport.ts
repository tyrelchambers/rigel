// Builds the messages produced after a chat-proposed action runs (with the
// user's approval), mirroring Swift's WorkloadResultReport. This is what closes
// the loop: the model proposes → the user approves + Rigel runs → the result
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
      "[Rigel executed the action you proposed — the user approved it.]",
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
    "[Rigel ran the action you proposed — the user approved it — but it FAILED.]",
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

/** One executed action in a batch (its previewed command + result). */
export interface BatchRun {
  commandString: string;
  result: ActionResult;
}

/**
 * The single hidden message fed back into the session after a batch of actions
 * ran (sequentially, stop-on-failure). Mirrors Swift's
 * `WorkloadResultReport.batchFeedback`: a header, one line per executed action
 * (success/FAILED + clipped output), the skipped queue, and a closing
 * continue/diagnose line. `skipped` are the previewed commands of actions that
 * never ran because an earlier one failed.
 */
export function batchFeedback(ran: BatchRun[], skipped: string[]): string {
  const lines = [
    "[Rigel ran a queue of actions you proposed — the user approved and ran them together.]",
    "",
  ];
  for (const { commandString, result } of ran) {
    if (result.code === 0) {
      lines.push(`• success: ${commandString}\n  output: ${clip(result.stdout, "(no output)")}`);
    } else {
      lines.push(`• FAILED (exit ${result.code}): ${commandString}\n  error: ${clip(result.stderr, "(no stderr)")}`);
    }
  }
  if (skipped.length > 0) {
    lines.push("");
    lines.push("Stopped after a failure — these queued actions were NOT run:");
    for (const cmd of skipped) lines.push(`• ${cmd}`);
  }
  lines.push("");
  lines.push(
    ran.some((r) => r.result.code !== 0)
      ? "Diagnose the failure and propose a corrected next step for the remaining work."
      : "Continue the task: confirm completion briefly, or proceed with the next step.",
  );
  return lines.join("\n");
}
