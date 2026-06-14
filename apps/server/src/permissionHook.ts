#!/usr/bin/env bun
// PreToolUse hook for the chat's headless `claude` session. Reads the tool-call
// JSON on stdin and emits a PreToolUse permission decision so cluster MUTATIONS
// are denied (and routed to the app's approve-and-run action block) while every
// read/investigation command runs unattended. See commandPolicy.ts.
//
// Wired via `--settings` in claudeBridge.ts (matcher: Bash). Output contract:
//   {"hookSpecificOutput":{"hookEventName":"PreToolUse",
//     "permissionDecision":"allow"|"deny","permissionDecisionReason":"..."}}
import { classifyCommand } from "./commandPolicy";

function emit(decision: "allow" | "deny", reason: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
  );
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;

  let input: any;
  try {
    input = JSON.parse(raw);
  } catch {
    // Unparseable input → defer to normal permission flow (no output, exit 0).
    return;
  }

  // Only Bash is gated here; anything else defers to the normal flow.
  if (input?.tool_name !== "Bash") return;
  const command: unknown = input?.tool_input?.command;
  if (typeof command !== "string" || command.trim() === "") {
    emit("allow", "no command");
    return;
  }

  const verdict = classifyCommand(command);
  emit(verdict.decision, verdict.reason);
}

main().catch(() => {
  // Never hard-fail the session on a hook bug: defer to normal permission rules
  // (which, with the read allowlist still in place, keep reads working).
});
