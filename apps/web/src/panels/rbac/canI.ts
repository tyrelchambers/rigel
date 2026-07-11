import type { PolicyRule } from "./types";

export interface CanICheck { verb: string; resource: string; apiGroup?: string; namespace?: string }
export interface CanIResult extends CanICheck { allowed: boolean | null }

/** Expand a role's rules into deduped, capped `can-i` checks (first apiGroup per
 *  rule). Keeps `*` entries — `can-i '*' '*'` is valid and meaningful. */
export function rulesToChecks(rules: PolicyRule[], namespace?: string, cap = 24): CanICheck[] {
  const seen = new Set<string>();
  const checks: CanICheck[] = [];
  for (const rule of rules) {
    const apiGroup = rule.apiGroups?.length ? rule.apiGroups[0] : "";
    for (const resource of rule.resources ?? []) {
      for (const verb of rule.verbs ?? []) {
        const key = `${verb} ${resource} ${apiGroup}`;
        if (seen.has(key)) continue;
        seen.add(key);
        checks.push({ verb, resource, apiGroup, namespace });
        if (checks.length >= cap) return checks;
      }
    }
  }
  return checks;
}
