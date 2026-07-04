// Types for the web RBAC panel. Mirrors the Swift `RBACTypes.swift` and the
// normative spec in `docs/parity/rbac.md`.
//
// ServiceAccounts, Roles, and RoleBindings are namespace-scoped; ClusterRoles
// and ClusterRoleBindings are cluster-scoped.

export interface ObjectMeta {
  name: string;
  namespace?: string;
  uid?: string;
  creationTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

/** PolicyRule — describes what a Role/ClusterRole permits. */
export interface PolicyRule {
  apiGroups?: string[]; // e.g. ["", "apps", "batch"]
  resources?: string[]; // e.g. ["pods", "services", "deployments"]
  verbs?: string[]; // e.g. ["get", "list", "watch", "create", ...]
}

/** RoleRef — reference from a Binding to a Role/ClusterRole. */
export interface RoleRef {
  kind?: string; // "Role" | "ClusterRole"
  name?: string;
}

/** Subject — who (user, group, or service account) is bound by a Binding. */
export interface Subject {
  kind?: string; // "User" | "Group" | "ServiceAccount"
  name?: string;
  namespace?: string; // Present only for ServiceAccount subjects
}

/** ServiceAccount (v1) — namespace-scoped. */
export interface ServiceAccount {
  metadata: ObjectMeta;
  secrets?: Array<{ name?: string }>;
}

/** Role (rbac.authorization.k8s.io/v1) — namespace-scoped. */
export interface Role {
  metadata: ObjectMeta;
  rules?: PolicyRule[];
}

/** ClusterRole (rbac.authorization.k8s.io/v1) — cluster-scoped. */
export interface ClusterRole {
  metadata: ObjectMeta;
  rules?: PolicyRule[];
}

/** RoleBinding (rbac.authorization.k8s.io/v1) — namespace-scoped. */
export interface RoleBinding {
  metadata: ObjectMeta;
  roleRef?: RoleRef;
  subjects?: Subject[];
}

/** ClusterRoleBinding (rbac.authorization.k8s.io/v1) — cluster-scoped. */
export interface ClusterRoleBinding {
  metadata: ObjectMeta;
  roleRef?: RoleRef;
  subjects?: Subject[];
}

/** Active kind toggle for the RBAC panel. */
export type RbacKind =
  | "serviceaccounts"
  | "roles"
  | "rolebindings"
  | "clusterroles"
  | "clusterrolebindings";

/** Scope filter for the panel (status-strip toggle). */
export type ScopeFilter = "all" | "namespaced" | "cluster";

/** View toggle for the left list pane. */
export type RbacView = "subjects" | "roles";

/** A subject reference, normalized for identity comparison. */
export interface SubjectRef {
  kind: string; // "ServiceAccount" | "User" | "Group"
  name: string;
  namespace?: string; // present only for ServiceAccount
}

/** Where a binding takes effect. */
export type BindingScope =
  | { kind: "Namespaced"; namespace: string }
  | { kind: "Cluster" };

/** One resolved binding: a role's rules granted to a subject, with scope. */
export interface Grant {
  bindingName: string;
  bindingKind: "RoleBinding" | "ClusterRoleBinding";
  roleRef: RoleRef;
  scope: BindingScope;
  rules: PolicyRule[];
}

/** A subject as shown in the left list, with a precomputed danger flag. */
export interface ListSubject extends SubjectRef {
  key: string;
  dangerous: boolean;
}
