// agent/src/executeActionGuarded.ts
import { classifyRisk, RiskTier } from "./classifier.js";
import { isRepoFixAction, type SuggestedAction } from "./action.js";
import type { CircuitBreaker } from "./guardrails.js";

export interface GuardedDeps {
  now(): number;
  execute(action: SuggestedAction): Promise<{ success: boolean; output: string; backupYaml: string | null; commands: string[] }>;
  storeBackup(key: string, yaml: string): Promise<string>;
  audit(entry: { command: string; success: boolean; output: string; backupRef?: string }): Promise<void>;
  log?(msg: string): void;
}

export interface GuardedContext {
  action: SuggestedAction;
  fingerprint: string;
  resourceKey: string;
}

/** Run one already-approved action through the circuit breaker + backup +
 *  execute + audit path, returning the operator reply string. Shared by the
 *  queue-approve command and the chat destructive-confirm path. */
export async function executeActionGuarded(
  cb: CircuitBreaker,
  ctx: GuardedContext,
  deps: GuardedDeps,
): Promise<string> {
  const { action, fingerprint, resourceKey } = ctx;
  if (isRepoFixAction(action.kind)) {
    return `"${action.label}" opens a fix PR and is handled by the fix-runner — not a command to run from here.`;
  }
  if (classifyRisk(action.kind) === RiskTier.Blocked && action.kind !== "command") {
    return `"${action.label}" is blocked from automatic execution. Run it from Rigel.`;
  }
  const now = deps.now();
  const verdict = cb.canAct(fingerprint, resourceKey, now);
  if (!verdict.allowed) return `Can't run that right now — ${verdict.reason}.`;
  cb.record(fingerprint, resourceKey, now);
  try {
    const result = await deps.execute(action);
    let backupRef: string | undefined;
    if (result.backupYaml) {
      backupRef = await deps.storeBackup(`${now}_${fingerprint}`.replace(/[^A-Za-z0-9_.-]/g, "_"), result.backupYaml);
    }
    await deps.audit({ command: result.commands.join(" && "), success: result.success, output: result.output, backupRef });
    deps.log?.(`${result.success ? "✓" : "✗"} ${action.label} — ${result.commands.join(" && ")}`);
    return result.success
      ? `✓ Ran: ${action.label}\n${result.commands.join(" && ")}`
      : `✗ Failed: ${action.label}\n${result.output}`.slice(0, 1200);
  } catch (e) {
    return `✗ Error running ${action.label}: ${String(e)}`;
  }
}
