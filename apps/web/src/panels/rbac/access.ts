import type {
  ClusterRole,
  ClusterRoleBinding,
  Grant,
  ListSubject,
  PolicyRule,
  Role,
  RoleBinding,
  RoleRef,
  Subject,
  SubjectRef,
} from "./types";
import { grantRisk } from "./risk";

/** Stable identity key for a subject. NUL-separated so parts can't collide. */
export function subjectKey(s: { kind?: string; name?: string; namespace?: string }): string {
  return `${s.kind ?? ""}\u0000${s.namespace ?? ""}\u0000${s.name ?? ""}`;
}

type AnyBinding = RoleBinding | ClusterRoleBinding;

function bindingScope(binding: AnyBinding, kind: Grant["bindingKind"]): Grant["scope"] {
  if (kind === "RoleBinding") {
    return { kind: "Namespaced", namespace: binding.metadata.namespace ?? "" };
  }
  return { kind: "Cluster" };
}

/** Resolve a RoleRef to its rules. Namespaced Roles match on binding namespace. */
export function resolveRoleRules(
  roleRef: RoleRef | undefined,
  bindingNamespace: string | undefined,
  roles: Role[],
  clusterRoles: ClusterRole[],
): PolicyRule[] {
  if (!roleRef?.name) return [];
  if (roleRef.kind === "ClusterRole") {
    return clusterRoles.find((r) => r.metadata.name === roleRef.name)?.rules ?? [];
  }
  return (
    roles.find(
      (r) => r.metadata.name === roleRef.name && r.metadata.namespace === bindingNamespace,
    )?.rules ?? []
  );
}

/** All resolved grants (binding → role rules) for a subject key. */
export function effectiveGrants(
  key: string,
  roleBindings: RoleBinding[],
  clusterRoleBindings: ClusterRoleBinding[],
  roles: Role[],
  clusterRoles: ClusterRole[],
): Grant[] {
  const grants: Grant[] = [];
  const push = (binding: AnyBinding, kind: Grant["bindingKind"]) => {
    if (!(binding.subjects ?? []).some((s) => subjectKey(s) === key)) return;
    const scope = bindingScope(binding, kind);
    grants.push({
      bindingName: binding.metadata.name,
      bindingKind: kind,
      roleRef: binding.roleRef ?? {},
      scope,
      rules: resolveRoleRules(
        binding.roleRef,
        scope.kind === "Namespaced" ? scope.namespace : undefined,
        roles,
        clusterRoles,
      ),
    });
  };
  for (const b of roleBindings) push(b, "RoleBinding");
  for (const b of clusterRoleBindings) push(b, "ClusterRoleBinding");
  return grants;
}

/** Reverse lookup: subjects bound to a given role. */
export function subjectsForRole(
  role: { kind: "Role" | "ClusterRole"; name: string; namespace?: string },
  roleBindings: RoleBinding[],
  clusterRoleBindings: ClusterRoleBinding[],
): { subject: Subject; bindingName: string; scope: Grant["scope"] }[] {
  const out: { subject: Subject; bindingName: string; scope: Grant["scope"] }[] = [];
  const match = (ref: RoleRef | undefined, ns: string | undefined) =>
    ref?.name === role.name &&
    (ref?.kind ?? "") === role.kind &&
    (role.kind === "ClusterRole" || ns === role.namespace);
  for (const b of roleBindings) {
    if (!match(b.roleRef, b.metadata.namespace)) continue;
    for (const s of b.subjects ?? [])
      out.push({ subject: s, bindingName: b.metadata.name, scope: bindingScope(b, "RoleBinding") });
  }
  for (const b of clusterRoleBindings) {
    if (!match(b.roleRef, undefined)) continue;
    for (const s of b.subjects ?? [])
      out.push({ subject: s, bindingName: b.metadata.name, scope: { kind: "Cluster" } });
  }
  return out;
}

/** Whether a subject holds any dangerous grant. */
export function subjectIsDangerous(
  key: string,
  roleBindings: RoleBinding[],
  clusterRoleBindings: ClusterRoleBinding[],
  roles: Role[],
  clusterRoles: ClusterRole[],
): boolean {
  return effectiveGrants(key, roleBindings, clusterRoleBindings, roles, clusterRoles).some(
    (g) => grantRisk(g.rules) === "dangerous",
  );
}

/** Unique subjects across all bindings, each with a precomputed danger flag. */
export function collectSubjects(
  roleBindings: RoleBinding[],
  clusterRoleBindings: ClusterRoleBinding[],
  roles: Role[],
  clusterRoles: ClusterRole[],
): ListSubject[] {
  const seen = new Map<string, SubjectRef>();
  for (const b of [...roleBindings, ...clusterRoleBindings]) {
    for (const s of b.subjects ?? []) {
      if (!s.name) continue;
      const key = subjectKey(s);
      if (!seen.has(key))
        seen.set(key, { kind: s.kind ?? "", name: s.name, namespace: s.namespace });
    }
  }
  return [...seen.entries()]
    .map(([key, ref]) => ({
      ...ref,
      key,
      dangerous: subjectIsDangerous(key, roleBindings, clusterRoleBindings, roles, clusterRoles),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Status-strip counts.
 *
 * Enumeration (which subjects/bindings/roles are listed) uses the scoped pools
 * passed as `roleBindings`/`clusterRoleBindings`/`roles`/`clusterRoles`. Danger
 * resolution uses `resolveRoles`/`resolveClusterRoles` — pass the FULL role
 * pools there so a namespaced RoleBinding that references a ClusterRole still
 * resolves its rules (and is correctly counted as dangerous). They default to
 * the scoped pools for callers that don't distinguish the two.
 */
export function rbacCounts(
  roleBindings: RoleBinding[],
  clusterRoleBindings: ClusterRoleBinding[],
  roles: Role[],
  clusterRoles: ClusterRole[],
  resolveRoles: Role[] = roles,
  resolveClusterRoles: ClusterRole[] = clusterRoles,
): { subjects: number; roles: number; bindings: number; dangerous: number } {
  const subjects = collectSubjects(
    roleBindings,
    clusterRoleBindings,
    resolveRoles,
    resolveClusterRoles,
  );
  return {
    subjects: subjects.length,
    roles: roles.length + clusterRoles.length,
    bindings: roleBindings.length + clusterRoleBindings.length,
    dangerous: subjects.filter((s) => s.dangerous).length,
  };
}
