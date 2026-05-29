import { backupTarget, toKubectlInvocations, type SuggestedAction } from "./action.js";
import { getManifestYaml, kubectl } from "./kubectl.js";

/**
 * Runs an approved action against the cluster, capturing a pre-mutation backup
 * first so the change is revertible. This is deterministic — no model is
 * involved; by the time we get here the action has already cleared the risk
 * classifier, the circuit breaker, and (for MEDIUM) the supervisor.
 */

export interface ExecutionResult {
  success: boolean;
  output: string;
  /** Pre-mutation `kubectl get -o yaml` snapshot, or null if the target was
   * absent. Stored so Helmsman can offer one-click revert. */
  backupYaml: string | null;
  /** Human-readable commands actually run. */
  commands: string[];
}

export async function executeAction(action: SuggestedAction): Promise<ExecutionResult> {
  const target = backupTarget(action);
  const backupYaml = await getManifestYaml(target.kind, target.name, target.namespace);

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
