import type { ObjectMeta, PolicyRule, Subject } from "./types";

/**
 * Pure display helpers for the RBAC panel. Mirrors the Swift `RBACDisplay` enum
 * and the sorting logic from `RBACViewModel.swift`, per the normative spec in
 * `docs/parity/rbac.md`.
 */

/**
 * Compact formatting of a binding's subject list (used in RoleBinding /
 * ClusterRoleBinding detail rows).
 *
 * - Returns "no subjects" if the list is null/undefined or empty.
 * - Abbreviates ServiceAccount → "sa"; other kinds are lowercased verbatim
 *   (User → "user", Group → "group"); missing kind → "?".
 * - ServiceAccount subjects with a namespace render "sa:<namespace>/<name>";
 *   otherwise "<kind>:<name>".
 * - Joins the first 3 with ", " and appends " +N" for any remainder.
 */
export function subjectsSummary(subjects: Subject[] | undefined): string {
  if (!subjects || subjects.length === 0) return "no subjects";

  const formatted = subjects.map((s) => {
    const rawKind = s.kind ?? "?";
    const kind = rawKind === "ServiceAccount" ? "sa" : rawKind.toLowerCase();
    const name = s.name ?? "";
    if (s.namespace) return `${kind}:${s.namespace}/${name}`;
    return `${kind}:${name}`;
  });

  const head = formatted.slice(0, 3).join(", ");
  const remaining = formatted.length - 3;
  return remaining > 0 ? `${head} +${remaining}` : head;
}

/** Format a single PolicyRule's apiGroups for display. */
function formatApiGroups(apiGroups: string[] | undefined): string {
  if (!apiGroups || apiGroups.length === 0) return "core";
  if (apiGroups.length === 1 && apiGroups[0] === "") return "core";
  return apiGroups.map((g) => (g === "" ? "core" : g)).join(", ");
}

/** Format a single PolicyRule's resources/verbs for display. */
function formatList(items: string[] | undefined): string {
  if (!items || items.length === 0) return "";
  return items.join(", ");
}

/**
 * Compact display of policy rules (used in expandable Role/ClusterRole detail).
 *
 * - Returns "no rules" if the list is null/undefined or empty.
 * - Formats each rule as "<apiGroups> <resources> <verbs>", with [""] / empty
 *   apiGroups shown as "core".
 * - Joins multiple rules with a newline + indent for multi-line display.
 */
export function rulesSummary(rules: PolicyRule[] | undefined): string {
  if (!rules || rules.length === 0) return "no rules";

  const lines = rules.map((r) => {
    const groups = formatApiGroups(r.apiGroups);
    const resources = formatList(r.resources);
    const verbs = formatList(r.verbs);
    return `${groups} ${resources} ${verbs}`;
  });

  return lines.join("\n  ");
}

/**
 * Case-insensitive substring match for filtering.
 *
 * - Trims/lowercases the query; an empty query always matches.
 * - Flattens searchFields into a space-separated haystack (excluding
 *   undefined/null), then checks for substring containment.
 */
export function matchesSearch(
  searchFields: (string | undefined)[],
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const haystack = searchFields
    .filter((f): f is string => f != null)
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

/**
 * Sort namespace-scoped resources (ServiceAccounts, Roles, RoleBindings) by
 * namespace (alphabetic, empty string first), then by name (lexicographic).
 * Returns a new array; does not mutate the input.
 */
export function sortByNamespaceName<T extends { metadata: ObjectMeta }>(
  items: T[],
): T[] {
  return [...items].sort((a, b) => {
    const nsA = a.metadata.namespace ?? "";
    const nsB = b.metadata.namespace ?? "";
    if (nsA !== nsB) return nsA < nsB ? -1 : 1;
    const nameA = a.metadata.name;
    const nameB = b.metadata.name;
    if (nameA === nameB) return 0;
    return nameA < nameB ? -1 : 1;
  });
}

/**
 * Sort cluster-scoped resources (ClusterRoles, ClusterRoleBindings) by name
 * (lexicographic). Returns a new array; does not mutate the input.
 */
export function sortByName<T extends { metadata: ObjectMeta }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const nameA = a.metadata.name;
    const nameB = b.metadata.name;
    if (nameA === nameB) return 0;
    return nameA < nameB ? -1 : 1;
  });
}
