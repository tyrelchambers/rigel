import { backupTarget, commandBackupTarget, toKubectlInvocations, type SuggestedAction } from "./action.js";
import { operatorManagedPodReason } from "./guardrails.js";
import { getManifestYaml, kubectl } from "./kubectl.js";

/**
 * Runs an approved action against the cluster, capturing a pre-mutation backup
 * first so the change is revertible. This is deterministic — no model is
 * involved; by the time we get here the action has already cleared its action
 * level (Review = the supervisor) and the circuit breaker.
 */

export interface ExecutionResult {
  success: boolean;
  output: string;
  /** Pre-mutation `kubectl get -o yaml` snapshot, or null if the target was
   * absent. Stored so Rigel can offer one-click revert. */
  backupYaml: string | null;
  /** Human-readable commands actually run. */
  commands: string[];
  blocked?: string;
}

const POD_KINDS = new Set(["pod", "pods", "po"]);

function podDeletionTarget(action: SuggestedAction): { name: string; namespace: string } | null {
  if (action.kind === "deletePod" && action.pod) return { name: action.pod, namespace: action.namespace ?? "default" };
  if (action.kind !== "command" || !action.args) return null;
  const t = commandBackupTarget(action.args);
  return t && POD_KINDS.has(t.kind.toLowerCase()) ? { name: t.name, namespace: t.namespace ?? "default" } : null;
}

async function deletionBlockReason(action: SuggestedAction): Promise<string | null> {
  const target = podDeletionTarget(action);
  if (!target) return null;
  const res = await kubectl(["get", "pod", target.name, "-n", target.namespace, "-o", "json"]);
  if (res.code !== 0) return `couldn't confirm ${target.name} is safe to delete (${res.stderr.trim() || "read failed"})`;
  try {
    return operatorManagedPodReason(JSON.parse(res.stdout));
  } catch {
    return `couldn't confirm ${target.name} is safe to delete (unreadable pod)`;
  }
}

export async function executeAction(action: SuggestedAction): Promise<ExecutionResult> {
  const blocked = await deletionBlockReason(action);
  if (blocked) return { success: false, output: `Not deleted: ${blocked}`, backupYaml: null, commands: [], blocked };
  const target = backupTarget(action);
  const backupYaml = target.name
    ? await getManifestYaml(target.kind, target.name, target.namespace)
    : null;

  const commands: string[] = [];
  let output = "";
  for (const args of toKubectlInvocations(action)) {
    commands.push("kubectl " + args.join(" "));
    const res = await kubectl(args);
    output += res.stdout + res.stderr;
    if (res.code !== 0) {
      return { success: false, output: output.trim(), backupYaml, commands };
    }
  }
  return { success: true, output: output.trim(), backupYaml, commands };
}
