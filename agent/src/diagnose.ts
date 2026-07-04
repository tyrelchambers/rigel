import { runModel } from "./runModel.js";
import type { RuntimeConfig } from "./runtimeConfig.js";

/**
 * Read-only, conversational diagnosis for an operator's inbound Signal message.
 * Unlike the autonomous worker (which is forced to emit a single ```action
 * block), this answers a free-text question in plain prose suitable for a phone.
 *
 * It investigates with ONLY the read-only kubectl allowlist, so it can never
 * mutate the cluster — texting the assistant a question is always safe. If a fix
 * is warranted it says so and points the operator at the approval flow; it does
 * not (and cannot) execute anything itself.
 */

/** Read-only investigation allowlist — the worker's kubectl surface plus the
 *  deterministic `rigel-audit` CLI (read-only) so the operator can ask for an
 *  audit and the model runs the real engine rather than eyeballing. Exported for
 *  the unit test. */
export const READ_ONLY_TOOLS = [
  "Bash(kubectl get *)",
  "Bash(kubectl describe *)",
  "Bash(kubectl logs *)",
  "Bash(kubectl top *)",
  "Bash(kubectl events *)",
  "Bash(kubectl explain *)",
  "Bash(rigel-audit *)",
];

const SYSTEM_PROMPT = `You are Rigel's cluster assistant, answering an operator's question over a text message (Signal).

Investigate the live cluster using ONLY read-only kubectl (get/describe/logs/top/events/explain). You CANNOT change anything — never claim to have made a change.

If the operator asks for a reliability, security, or performance audit, run \`rigel-audit <reliability|security|performance> --json\` — a deterministic audit engine. On a large cluster, pipe it through \`jq\` to summarize (e.g. \`| jq '.counts'\`) before reading the full list. Report the findings grouped by severity (critical first), concisely. NEVER invent CPU or memory request/limit numbers: size a fix only from a finding's \`evidence\` field; if a finding has no \`evidence\`, say a metrics backend is needed to size it. Do not re-run detection or invent findings beyond the CLI output.

Answer for a phone screen: lead with the direct answer, then a sentence or two of supporting detail. Plain text only — no markdown tables, no long code blocks, keep it under ~1200 characters when you can. If a remediation is warranted, name it in one line and tell the operator they can reply "queue" to see pending fixes and "approve N" to run one (only fixes the autonomous loop has already queued can be approved this way). If you are unsure, say what you'd check next rather than guessing.`;

export interface DiagnosisOutput {
  text: string;
  costUsd: number;
  sessionId: string;
}

/** Investigate and answer a single operator question. Rejects on model/exec
 * failure so the caller can reply with an error rather than silence. */
export async function runDiagnosis(
  rc: RuntimeConfig,
  question: string,
  resumeSessionId?: string,
): Promise<DiagnosisOutput> {
  const result = await runModel({
    role: "worker",
    config: rc,
    prompt: question,
    systemPrompt: SYSTEM_PROMPT,
    allowedReads: READ_ONLY_TOOLS,
    resumeSessionId,
    timeoutMs: 150_000,
  });
  if (result.isError) {
    // Reject on failure so the caller can reply with an error rather than silence.
    throw new Error(result.errorMessage ?? "diagnosis failed");
  }
  return { text: result.text, costUsd: result.costUsd, sessionId: result.sessionId ?? "" };
}
