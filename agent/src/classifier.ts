/**
 * Risk tiering for a proposed remediation, per the approved Assistant plan.
 *
 * This is a hard, deterministic gate that sits *underneath* the models — it is
 * not advice the worker can argue with. It mirrors the autonomy tiers the user
 * chose:
 *   - LOW     → auto-remediate on deterministic guardrails alone (no model gate)
 *   - MEDIUM  → require Opus supervisor approval before executing
 *   - BLOCKED → never executable by the agent; surfaced as a suggestion only
 *
 * Anything not explicitly LOW or MEDIUM is BLOCKED. Fail safe: an unknown or
 * destructive kind can never slip through to execution.
 */
export enum RiskTier {
  Low = "low",
  Medium = "medium",
  Blocked = "blocked",
}

const LOW: ReadonlySet<string> = new Set(["restart", "rollback", "deletePod", "cordon"]);
// `openFixPR` opens a pull request against the workload's GitOps source rather
// than mutating the cluster, so it never clears LOW: the Opus supervisor must vet
// the proposed change before a PR is opened on the user's behalf.
const MEDIUM: ReadonlySet<string> = new Set(["scale", "setEnv", "uncordon", "openFixPR"]);

export function classifyRisk(kind: string): RiskTier {
  if (LOW.has(kind)) return RiskTier.Low;
  if (MEDIUM.has(kind)) return RiskTier.Medium;
  return RiskTier.Blocked;
}
