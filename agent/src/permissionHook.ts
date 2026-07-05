#!/usr/bin/env node
// PreToolUse hook for the agent's chat `claude` turn. Reads a tool-call JSON on
// stdin and emits an allow/deny decision: reads + REVERSIBLE mutations run
// unattended; DESTRUCTIVE ones are denied and steered to a confirm-over-text
// action block. Wired via --settings in chatTurn.ts (matcher: Bash). Mirrors
// apps/server/permissionHook.ts but three-tiered.
import { classifyTier } from "@rigel/k8s/src/commandPolicy.js";
import { fileURLToPath } from "node:url";

export interface HookDecision {
  permissionDecision: "allow" | "deny";
  permissionDecisionReason: string;
}

/** Pure decision for one Bash command. read/reversible → allow, else deny. */
export function decide(command: string): HookDecision {
  const { tier, reason } = classifyTier(command);
  if (tier === "read" || tier === "reversible") {
    return { permissionDecision: "allow", permissionDecisionReason: reason };
  }
  return { permissionDecision: "deny", permissionDecisionReason: reason };
}

function emit(d: HookDecision): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", ...d },
    }),
  );
}

export async function main(): Promise<void> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input: any;
  try {
    input = JSON.parse(raw);
  } catch {
    return; // unparseable → defer to normal flow
  }
  if (input?.tool_name !== "Bash") return;
  const command: unknown = input?.tool_input?.command;
  if (typeof command !== "string" || command.trim() === "") {
    emit({ permissionDecision: "allow", permissionDecisionReason: "no command" });
    return;
  }
  emit(decide(command));
}

/** True when THIS file is the process entry (bundling-safe, mirrors guardedKubectl). */
export function isHookEntry(entryPath: string | undefined): boolean {
  return !!entryPath && /(?:^|[\\/])permissionHook\.(?:js|ts)$/.test(entryPath);
}

/** The command that runs this hook: node+tsx in dev, override in the image. */
export function hookRunnerCommand(): string {
  const entry = fileURLToPath(new URL("./permissionHook.ts", import.meta.url));
  return process.env.RIGEL_AGENT_HOOK_CMD || `node --import tsx '${entry}'`;
}

if (isHookEntry(process.argv[1])) {
  main().catch(() => {});
}
