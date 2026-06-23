import { runModel } from "./runModel.js";
import type { RuntimeConfig } from "./runtimeConfig.js";
import type { Incident } from "./detector.js";
import type { SuggestedAction } from "./action.js";

/**
 * The Opus supervisor: a second, independent, deliberately adversarial review
 * of a MEDIUM-risk action the cheap worker proposed. Its job is to find a
 * reason NOT to run the action — so it acts as a real skeptic, not a rubber
 * stamp. Only `approve` lets a MEDIUM action through; anything else is
 * fail-closed (reject → skip, escalate → queue for the human).
 *
 * Note this layer sits ON TOP of, never instead of, the deterministic
 * guardrails (RBAC cage, circuit breaker). It cannot widen what the agent may
 * do — only narrow it.
 */

export type Decision = "approve" | "reject" | "escalate";

export interface Verdict {
  decision: Decision;
  confidence: number;
  reason: string;
}

const DECISIONS = new Set<Decision>(["approve", "reject", "escalate"]);

const VERDICT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    decision: { type: "string", enum: ["approve", "reject", "escalate"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" },
  },
  required: ["decision", "confidence", "reason"],
  additionalProperties: false,
});

const SYSTEM_PROMPT = `You are the SUPERVISOR in an autonomous Kubernetes remediation system. A cheaper model proposed a change while the operator is asleep. Your job is adversarial: find any reason the proposed action is WRONG, unjustified by the evidence, riskier than it looks, or unlikely to fix the root cause.

Decide:
- "approve" ONLY if you are confident the action is correct, safe, and addresses the incident.
- "reject" if it is wrong, unsupported by the evidence, or likely to make things worse.
- "escalate" if it might be right but you are not confident enough to act unattended — defer to a human.

Default to caution: if uncertain, do NOT approve. Investigate with read-only kubectl before deciding. Respond via the structured schema only.`;

/** Validate a structured verdict object. Throws on anything malformed so the
 * caller treats it as fail-closed (does not execute). */
export function parseVerdict(obj: unknown): Verdict {
  if (typeof obj !== "object" || obj === null) {
    throw new Error("supervisor verdict is not an object");
  }
  const o = obj as Record<string, unknown>;
  if (typeof o.decision !== "string" || !DECISIONS.has(o.decision as Decision)) {
    throw new Error(`supervisor verdict has an invalid decision: ${String(o.decision)}`);
  }
  const rawConfidence = typeof o.confidence === "number" && Number.isFinite(o.confidence) ? o.confidence : 0;
  return {
    decision: o.decision as Decision,
    confidence: Math.min(1, Math.max(0, rawConfidence)),
    reason: typeof o.reason === "string" ? o.reason : "",
  };
}

const READ_ONLY_TOOLS = [
  "Bash(kubectl get *)",
  "Bash(kubectl describe *)",
  "Bash(kubectl logs *)",
  "Bash(kubectl top *)",
  "Bash(kubectl events *)",
];

export interface SupervisorOutput {
  verdict: Verdict;
  costUsd: number;
}

export async function runSupervisor(
  rc: RuntimeConfig,
  incident: Incident,
  action: SuggestedAction,
  workerAnalysis: string,
  command: string,
): Promise<SupervisorOutput> {
  const loc = incident.namespace ? `${incident.namespace}/${incident.name}` : incident.name;
  const prompt = `Incident: [${incident.incidentKind}] ${loc} — ${incident.reason}${
    incident.detail ? ` (${incident.detail})` : ""
  }

The worker proposed this remediation:
  label: ${action.label}
  kind: ${action.kind}
  command that will run: ${command}

Worker's analysis:
${workerAnalysis}

Independently verify against the live cluster (read-only), then return your verdict.`;

  const result = await runModel({
    role: "supervisor",
    config: rc,
    prompt,
    systemPrompt: SYSTEM_PROMPT,
    allowedReads: READ_ONLY_TOOLS,
    structuredSchema: VERDICT_SCHEMA,
    // Wrap parseVerdict in a boolean check so a malformed verdict triggers
    // runModel's one reprompt, then fail-closed (THROW → loop escalates).
    validateStructured: (o) => {
      try {
        parseVerdict(o);
        return true;
      } catch {
        return false;
      }
    },
    timeoutMs: 150_000,
  });

  if (result.isError || result.structuredOutput === undefined) {
    // Fail closed: never auto-approve on a bad/absent verdict. The loop's existing
    // catch maps this throw to "escalated/queued".
    throw new Error(
      `supervisor verdict unavailable (fail-closed): ${result.errorMessage ?? "no structured output"}`,
    );
  }
  // runModel already ran validateStructured (which wraps parseVerdict) before returning
  // isError:false, so structuredOutput is guaranteed to be a well-formed Verdict here.
  // Cast is safe: validateStructured is parseVerdict in a boolean wrapper, so any output
  // that passed it has the correct shape + decision enum value.
  return { verdict: result.structuredOutput as Verdict, costUsd: result.costUsd };
}
