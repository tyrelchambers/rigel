import type { PolicyRule } from "./types";

/** Risk tier for a policy rule or grant. `null` = benign. */
export type RiskTier = "dangerous" | "wildcard" | null;

const DANGEROUS_VERBS = new Set(["escalate", "bind", "impersonate"]);
const READ_VERBS = new Set(["get", "list", "watch", "*"]);

/**
 * Classify a single policy rule.
 * - dangerous: escalation verbs (escalate/bind/impersonate); OR reads that can
 *   reach secrets (secrets or wildcard resource with a read verb); OR full
 *   wildcard (verbs * AND resources *). cluster-admin (`*`/`*`/`*`) falls out
 *   of the full-wildcard branch, so no name special-casing is needed.
 * - wildcard: a lone `*` in verbs or resources that isn't already dangerous.
 * - null: everything else.
 */
export function ruleRisk(rule: PolicyRule): RiskTier {
  const verbs = rule.verbs ?? [];
  const resources = rule.resources ?? [];
  const verbWild = verbs.includes("*");
  const resWild = resources.includes("*");

  if (verbs.some((v) => DANGEROUS_VERBS.has(v))) return "dangerous";

  const readsSomething = verbs.some((v) => READ_VERBS.has(v));
  const reachesSecrets = resources.includes("secrets") || resWild;
  if (reachesSecrets && readsSomething) return "dangerous";

  if (verbWild && resWild) return "dangerous";
  if (verbWild || resWild) return "wildcard";
  return null;
}

/** Worst-of the rules' risk. Ordering: dangerous > wildcard > null. */
export function grantRisk(rules: PolicyRule[] | undefined): RiskTier {
  let worst: RiskTier = null;
  for (const rule of rules ?? []) {
    const r = ruleRisk(rule);
    if (r === "dangerous") return "dangerous";
    if (r === "wildcard") worst = "wildcard";
  }
  return worst;
}
