import { parseActions, type SuggestedAction } from "./action.js";
import { runModel } from "./runModel.js";
import type { RuntimeConfig } from "./runtimeConfig.js";
import type { Incident } from "./detector.js";
import type { ResolvedRepo } from "./repoResolve.js";

/**
 * The Worker stage: hands a detected incident to a cheap, fast model
 * (Sonnet by default) which investigates read-only and returns (1) a TRIAGE
 * VERDICT — is this error acceptable, actionable, or uncertain — and (2) at most
 * one proposed remediation as a fenced ```action block. The worker can only
 * READ — every mutation it proposes is gated downstream by the triage verdict,
 * the classifier, the circuit breaker and (for MEDIUM) the Opus supervisor. It
 * never executes anything itself.
 *
 * When (and only when) a workload was passed as autofix-eligible (a GitOps source
 * resolved for it), the worker MAY instead propose an `openFixPR` action that
 * opens a pull request against that source. Eligibility is communicated per
 * incident in the prompt; the loop independently gates the routing, so a stray
 * proposal can never escape.
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

/** The worker's triage of an incident. Conservative bias: anything not clearly
 *  acceptable or a clear, fixable defect is `uncertain` — never auto-acted on. */
export type TriageVerdict = "acceptable" | "actionable" | "uncertain";
const TRIAGE_VERDICTS = new Set<TriageVerdict>(["acceptable", "actionable", "uncertain"]);

const SYSTEM_PROMPT = `You are Rigel's autonomous cluster remediation assistant, running unattended inside a Kubernetes cluster while the operator is asleep.

You investigate an incident using ONLY read-only kubectl (get/describe/logs/top/events/explain).

STEP 1 — Triage. Judge the incident and emit your verdict as a single fenced \`\`\`verdict block:
  { "verdict": <one of: acceptable|actionable|uncertain>, "reason": <short string> }
- "acceptable": the error is expected or benign — a handled error, a routine/known warning, or a transient blip that has already self-recovered. No fix is warranted.
- "actionable": a real, fixable defect with a clear root cause and a safe remediation.
- "uncertain": you cannot confidently tell whether it is a real defect, or what the correct fix is.
When in doubt, choose "uncertain" — NEVER "actionable".

STEP 2 — Remediation. ONLY when your verdict is "actionable" you MAY propose AT MOST ONE remediation as a single fenced \`\`\`action block. For "acceptable" or "uncertain", emit NO action.

kubectl remediation schema (emit a single object):
  { "label": string, "kind": <one of: restart|scale|rollback|setEnv|deletePod|cordon|uncordon>,
    "deployment"?: string, "pod"?: string, "node"?: string, "namespace"?: string,
    "replicas"?: number, "env"?: {string:string} }

Source-fix remediation (openFixPR) — available ONLY when the incident below is explicitly marked "autofix-eligible". It opens a pull request against the workload's GitOps source instead of touching the cluster, for when the root cause is a defect in the committed manifest/config (a bad image tag, a wrong env value, an incorrect/missing field) rather than a transient runtime fault. When eligible AND the root cause is such a defect, propose it INSTEAD of a kubectl action:
  { "label": string, "kind": "openFixPR", "source": <the GitOps source name given below>,
    "filePath": <repo-relative path of the SINGLE file to change>,
    "content": <the COMPLETE corrected contents of that file>,
    "title": <pull-request title>, "body": <pull-request body explaining the root cause and the fix> }
Change exactly ONE file, make the MINIMAL edit that fixes the root cause, and NEVER emit openFixPR when the incident is not marked autofix-eligible.

Guidance:
- Prefer the least invasive fix that addresses root cause. A pod stuck in CrashLoopBackOff after a recent rollout usually wants "rollback"; a transient crash wants "restart"; a wedged single pod managed by a controller wants "deletePod".
- Only propose kubectl actions whose kind is in the list above. Anything destructive (deleting namespaces/PVCs/volumes, draining nodes, editing secrets/RBAC) is NOT available to you — if that is what's truly needed, do NOT emit an action; set the verdict to "uncertain" and explain in prose so it can be queued for the human.
- Always include the namespace. Be concise.`;

export interface WorkerOutput {
  /** Triage verdict — defaults SAFELY to "uncertain" when absent/garbled. */
  verdict: TriageVerdict;
  /** The worker's short reason for the verdict (for the audit/queue note). */
  verdictReason: string;
  actions: SuggestedAction[];
  analysis: string;
  costUsd: number;
  /** The model call FAILED (provider/credential error) — distinct from an
   *  "uncertain" triage, so the loop records it low-noise and never queues a note. */
  failed: boolean;
}

export async function runWorker(
  rc: RuntimeConfig,
  incidents: Incident[],
  repo?: ResolvedRepo | null,
): Promise<WorkerOutput> {
  const result = await runModel({
    role: "worker",
    config: rc,
    prompt: buildPrompt(incidents, repo ?? null),
    systemPrompt: SYSTEM_PROMPT,
    allowedReads: READ_ONLY_TOOLS,
    timeoutMs: 120_000,
  });
  if (result.isError) {
    // Fail closed: a worker failure is NOT a triage verdict. Surface it as a
    // failed output (verdict uncertain, no actions) so the loop records it
    // low-noise and never acts — and never mistakes it for "uncertain".
    const msg = result.errorMessage ?? "worker failed";
    return { verdict: "uncertain", verdictReason: msg, actions: [], analysis: msg, costUsd: 0, failed: true };
  }
  const triage = parseTriageVerdict(result.text);
  return {
    verdict: triage.verdict,
    verdictReason: triage.reason,
    actions: parseActions(result.text),
    analysis: result.text,
    costUsd: result.costUsd,
    failed: false,
  };
}

/**
 * Decode the worker's triage verdict from a closed ```verdict fence. Mirrors the
 * robustness of `parseActions`: a missing, unterminated, garbled, or unknown
 * verdict DEFAULTS SAFELY to "uncertain" (never "actionable"), so the loop can
 * never auto-act on a bad verdict. Returns the FIRST valid verdict block.
 */
export function parseTriageVerdict(text: string): { verdict: TriageVerdict; reason: string } {
  const fallback = { verdict: "uncertain" as TriageVerdict, reason: "" };
  if (!text.includes("```")) return fallback;
  const parts = text.split("```");
  for (let i = 1; i < parts.length; i += 2) {
    const isClosed = i < parts.length - 1; // an unterminated trailing fence is dropped
    if (!isClosed) continue;
    const part = parts[i] ?? "";
    const nl = part.indexOf("\n");
    const lang = (nl === -1 ? part : part.slice(0, nl)).trim().toLowerCase();
    if (lang !== "verdict") continue;
    const body = nl === -1 ? "" : part.slice(nl + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const o = parsed as Record<string, unknown>;
    const raw = typeof o.verdict === "string" ? o.verdict.trim().toLowerCase() : "";
    if (!TRIAGE_VERDICTS.has(raw as TriageVerdict)) continue;
    return { verdict: raw as TriageVerdict, reason: typeof o.reason === "string" ? o.reason : "" };
  }
  return fallback;
}

function buildPrompt(incidents: Incident[], repo: ResolvedRepo | null): string {
  const lines = incidents.map((i) => {
    const loc = i.namespace ? `${i.namespace}/${i.name}` : i.name;
    const restarts = i.restarts !== undefined ? `, restarts=${i.restarts}` : "";
    const detail = i.detail ? ` (${i.detail})` : "";
    return `- [${i.incidentKind}] ${loc}: ${i.reason}${detail}${restarts}`;
  });
  const eligibility = repo
    ? `\n\nThis workload is autofix-eligible. Its GitOps source is "${repo.source}" (repo ${repo.repoURL}@${repo.branch}, manifest directory "${repo.path}"). If the root cause is a defect in its committed manifest/config, you MAY propose an openFixPR against that source instead of a kubectl action.`
    : `\n\nThis workload is NOT autofix-eligible — do NOT propose an openFixPR. Only a kubectl action or no action.`;
  return `The following incident(s) were just detected in the cluster:\n\n${lines.join(
    "\n",
  )}${eligibility}\n\nInvestigate with read-only kubectl, then emit your \`\`\`verdict block and (only if actionable) at most one \`\`\`action block.`;
}
