import { parseActions, type SuggestedAction } from "./action.js";
import { runClaude } from "./claude.js";
import type { Config } from "./config.js";
import type { Incident } from "./detector.js";

/**
 * The Worker stage: hands a detected incident to a cheap, fast model
 * (Sonnet by default) which investigates read-only and proposes a remediation
 * as a fenced ```action block. The worker can only READ — every mutation it
 * proposes is gated downstream by the classifier, circuit breaker and (for
 * MEDIUM) the Opus supervisor. It never executes anything itself.
 */

/** Read-only kubectl allowlist — mirrors ClaudeSession.readOnlyKubectlAllowlist
 * in the Swift app. The worker investigates with these; nothing here mutates. */
const READ_ONLY_TOOLS = [
  "Bash(kubectl get *)",
  "Bash(kubectl describe *)",
  "Bash(kubectl logs *)",
  "Bash(kubectl top *)",
  "Bash(kubectl events *)",
  "Bash(kubectl explain *)",
];

const SYSTEM_PROMPT = `You are Rigel's autonomous cluster remediation assistant, running unattended inside a Kubernetes cluster while the operator is asleep.

You investigate an incident using ONLY read-only kubectl (get/describe/logs/top/events). You then propose AT MOST ONE remediation as a single fenced \`\`\`action block, or state that no safe automatic action applies.

The action JSON schema (emit a single object):
  { "label": string, "kind": <one of: restart|scale|rollback|setEnv|deletePod|cordon|uncordon>,
    "deployment"?: string, "pod"?: string, "node"?: string, "namespace"?: string,
    "replicas"?: number, "env"?: {string:string} }

Guidance:
- Prefer the least invasive fix that addresses root cause. A pod stuck in CrashLoopBackOff after a recent rollout usually wants "rollback"; a transient crash wants "restart"; a wedged single pod managed by a controller wants "deletePod".
- Only propose actions whose kind is in the list above. Anything destructive (deleting namespaces/PVCs/volumes, draining nodes, editing secrets/RBAC) is NOT available to you — if that is what's truly needed, do NOT emit an action; instead explain it in prose so it can be queued for the human.
- If you are not confident a safe automatic remediation exists, emit no action and briefly explain why.
- Always include the namespace. Be concise.`;

export interface WorkerOutput {
  actions: SuggestedAction[];
  analysis: string;
  costUsd: number;
}

export async function runWorker(cfg: Config, incidents: Incident[]): Promise<WorkerOutput> {
  const result = await runClaude({
    model: cfg.workerModel,
    prompt: buildPrompt(incidents),
    appendSystemPrompt: SYSTEM_PROMPT,
    allowedTools: READ_ONLY_TOOLS,
    timeoutMs: 120_000,
  });
  return {
    actions: parseActions(result.text),
    analysis: result.text,
    costUsd: result.costUsd,
  };
}

function buildPrompt(incidents: Incident[]): string {
  const lines = incidents.map((i) => {
    const loc = i.namespace ? `${i.namespace}/${i.name}` : i.name;
    const restarts = i.restarts !== undefined ? `, restarts=${i.restarts}` : "";
    const detail = i.detail ? ` (${i.detail})` : "";
    return `- [${i.incidentKind}] ${loc}: ${i.reason}${detail}${restarts}`;
  });
  return `The following incident(s) were just detected in the cluster:\n\n${lines.join(
    "\n",
  )}\n\nInvestigate with read-only kubectl, then propose at most one safe remediation as an \`\`\`action block, or explain why no automatic action is safe.`;
}
