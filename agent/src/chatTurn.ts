import { hookRunnerCommand } from "./permissionHook.js";
import { runModel } from "./runModel.js";
import type { RuntimeConfig } from "./runtimeConfig.js";

/** Reads + read filters the model may run without the hook prompting. Mirrors
 *  claudeBridge.READ_ONLY_ALLOWLIST; the hook governs mutations. */
export const CHAT_ALLOWLIST = [
  "Bash(kubectl get *)", "Bash(kubectl describe *)", "Bash(kubectl logs *)",
  "Bash(kubectl top *)", "Bash(kubectl events *)", "Bash(kubectl explain *)",
  "Bash(kubectl api-resources*)", "Bash(kubectl auth can-i *)",
  "Bash(rigel-audit *)",
  "Bash(awk *)", "Bash(sed *)", "Bash(cut *)", "Bash(sort *)", "Bash(uniq *)",
  "Bash(column *)", "Bash(tr *)", "Bash(jq *)", "Bash(yq *)",
  "Bash(echo *)", "Bash(cat *)", "Bash(grep *)", "Bash(head *)", "Bash(tail *)",
  // Reversible + destructive kubectl/helm are NOT allowlisted; the PreToolUse
  // hook decides them (reversible → allow, destructive → deny→confirm).
  "Bash(kubectl *)", "Bash(helm *)",
];

/** Inline --settings JSON registering the PreToolUse permission hook. */
export function chatHookSettings(): string {
  return JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: hookRunnerCommand() }] }] },
  });
}

export function chatSystemPrompt(): string {
  return `You are Rigel's cluster assistant, texting with the operator over a chat app. You have a real kubectl/helm Bash tool against the LIVE cluster.

Investigate freely with any read command. When a change is warranted, JUST DO reversible changes directly with kubectl/helm (restart, scale, rollback, apply, edit, set, cordon, uncordon, label, trigger a job, helm upgrade) — you don't need to ask first; the operator texted you to act.

DESTRUCTIVE changes (delete, drain, helm uninstall, anything irreversible) are blocked from running directly and need the operator's go-ahead. When one is warranted, DESCRIBE in one or two lines exactly what you'd run and why, and ask them to confirm — do NOT emit an action block on this turn. Only once they confirm in their next message (any natural "yes"/"go ahead"/"do it") do you emit a fenced \`\`\`action block: {"kind":"command","args":[<kubectl/helm args WITHOUT the binary or --context>],"destructive":true,"label":"<short label>"}. Emitting the block runs the command immediately through a backup + safety guard, so emit it only when you have their go-ahead — never in the same message where you first propose it.

Reply for a phone screen: lead with what you did or found, then a sentence of detail. Plain text, no markdown tables, under ~1200 chars. If you couldn't do something (RBAC denied, resource missing), say so plainly.`;
}

export interface ChatTurnOutput {
  text: string;
  sessionId: string;
  costUsd: number;
}

/** One act-capable chat turn. Investigation + reversible mutations run inline;
 *  destructive attempts are hook-denied and surface as an action block in `text`. */
export async function runChatTurn(rc: RuntimeConfig, message: string, resumeSessionId?: string): Promise<ChatTurnOutput> {
  const result = await runModel({
    role: "worker",
    config: rc,
    prompt: message,
    systemPrompt: chatSystemPrompt(),
    allowedReads: CHAT_ALLOWLIST,
    settingsJson: chatHookSettings(),
    resumeSessionId,
    timeoutMs: 180_000,
  });
  if (result.isError) throw new Error(result.errorMessage ?? "chat turn failed");
  return { text: result.text, sessionId: result.sessionId ?? "", costUsd: result.costUsd };
}
