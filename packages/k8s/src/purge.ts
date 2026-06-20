// Purge (app removal) — pure discovery / guardrail / helm-detection logic.
//
// This module is the byte-for-byte port of the Swift purge core
// (Sources/Rigel/Panels/Purge/*). It holds ZERO process spawning — only the
// pure functions the server route composes around `kubectl`/`helm`. Keeping it
// in @rigel/k8s lets both the server route and its tests import the same
// guardrails without touching the cluster.
//
// See docs/parity/purge.md for the normative spec.

// ---------------------------------------------------------------------------
// Discoverable kinds & kubectl normalization
// ---------------------------------------------------------------------------

/**
 * The comma-joined kind list fed to the discovery `kubectl get`. Order is part
 * of the spec (docs/parity/purge.md kind list).
 */
export const DISCOVERY_KINDS = [
  "deployments",
  "statefulsets",
  "daemonsets",
  "services",
  "ingresses",
  "configmaps",
  "secrets",
  "persistentvolumeclaims",
  "jobs",
  "cronjobs",
  "serviceaccounts",
] as const;

/**
 * Canonical (singular) resource kinds as surfaced to the client + used for the
 * `kubectl delete <kind>` verb. PVCs use the `persistentvolumeclaim` long form
 * here; the delete builder normalizes it to `pvc`.
 */
export type ResourceKind =
  | "deployment"
  | "statefulset"
  | "daemonset"
  | "service"
  | "ingress"
  | "configmap"
  | "secret"
  | "persistentvolumeclaim"
  | "job"
  | "cronjob"
  | "serviceaccount";

/**
 * Map a Kubernetes `kind` field (from `-o json`, e.g. "Deployment",
 * "PersistentVolumeClaim") to our canonical lowercase ResourceKind. Returns
 * null for kinds we do not purge.
 */
export function canonicalKind(rawKind: string): ResourceKind | null {
  switch (rawKind.toLowerCase()) {
    case "deployment":
      return "deployment";
    case "statefulset":
      return "statefulset";
    case "daemonset":
      return "daemonset";
    case "service":
      return "service";
    case "ingress":
      return "ingress";
    case "configmap":
      return "configmap";
    case "secret":
      return "secret";
    case "persistentvolumeclaim":
      return "persistentvolumeclaim";
    case "job":
      return "job";
    case "cronjob":
      return "cronjob";
    case "serviceaccount":
      return "serviceaccount";
    default:
      return null;
  }
}

/** Kinds treated as "workloads" for the core-prefix match (vs. dependents). */
const WORKLOAD_KINDS: ReadonlySet<ResourceKind> = new Set([
  "deployment",
  "statefulset",
  "daemonset",
]);

/**
 * Normalize a canonical kind to the shortest stable kubectl delete verb.
 * `persistentvolumeclaim` becomes `pvc`; everything else is already a valid verb.
 */
export function kubectlDeleteKind(kind: ResourceKind): string {
  return kind === "persistentvolumeclaim" ? "pvc" : kind;
}

/** PVCs are the only kind that defaults to UNselected (data opt-in). */
export function defaultSelected(kind: ResourceKind): boolean {
  return kind !== "persistentvolumeclaim";
}

// ---------------------------------------------------------------------------
// Guardrails — protected namespaces & shared-infra workloads
// ---------------------------------------------------------------------------

/** Exact-match protected namespaces (never purgeable). */
const PROTECTED_NAMESPACES: ReadonlySet<string> = new Set([
  "kube-system",
  "kube-public",
  "kube-node-lease",
  "default-system",
  "cert-manager",
  "cnpg-system",
]);

/** Prefix-match protected namespaces (never purgeable). */
const PROTECTED_NAMESPACE_PREFIXES = [
  "kube-",
  "cattle-",
  "fleet-",
  "tigera-",
  "calico-",
] as const;

/**
 * Shared infrastructure workload names — never deleted (only their data, via
 * the database-drop hint). Matched as an identity-core equality, so
 * `postgres`, `postgres-0`, `app-postgres` all resolve to a protected core.
 */
const SHARED_INFRA_WORKLOADS: ReadonlySet<string> = new Set([
  "postgres",
  "mysql",
  "mariadb",
  "redis",
  "postgres-pooler",
]);

/**
 * True when `namespace` is off-limits to purging. Mirrors the Swift
 * `PurgeGuardrails.isProtectedNamespace`.
 */
export function isProtectedNamespace(namespace: string): boolean {
  if (PROTECTED_NAMESPACES.has(namespace)) return true;
  return PROTECTED_NAMESPACE_PREFIXES.some((p) => namespace.startsWith(p));
}

/** Human-readable block reason for a protected namespace, or null if allowed. */
export function blockedNamespaceReason(namespace: string): string | null {
  if (!isProtectedNamespace(namespace)) return null;
  return `${namespace} is a protected system namespace`;
}

/**
 * True when a workload name is a shared-infra resource that must never be
 * deleted. Compares the identity core so role/instance suffixes do not let an
 * `app-postgres-0` slip past the guard.
 */
export function isSharedInfraWorkload(name: string): boolean {
  if (SHARED_INFRA_WORKLOADS.has(name)) return true;
  const c = core(name);
  return SHARED_INFRA_WORKLOADS.has(c) || SHARED_INFRA_WORKLOADS.has(name.toLowerCase());
}

// ---------------------------------------------------------------------------
// Identity-core matching
// ---------------------------------------------------------------------------

/**
 * Role/env tokens dropped when computing a name's identity core. Lowercased.
 * Mirrors the Swift `PurgeCore.roleTokens` set exactly.
 */
const ROLE_TOKENS: ReadonlySet<string> = new Set([
  "staging",
  "stg",
  "production",
  "prod",
  "dev",
  "test",
  "web",
  "api",
  "server",
  "client",
  "app",
  "svc",
  "service",
  "worker",
  "deploy",
  "deployment",
  "frontend",
  "backend",
  "ui",
  "site",
]);

/** Minimum core length for prefix matching; shorter cores require exact equality. */
export const MIN_CORE_LEN = 4;

/**
 * Extract the identity core from a resource name:
 *   1. lowercase
 *   2. split on `-` or `_`
 *   3. drop role/env tokens
 *   4. rejoin kept tokens (if ALL tokens are role tokens, keep them all)
 *
 * Mirrors the Swift `PurgeCore.core(_:)`.
 */
export function core(name: string): string {
  const tokens = name.toLowerCase().split(/[-_]/).filter((t) => t.length > 0);
  if (tokens.length === 0) return name.toLowerCase();
  const kept = tokens.filter((t) => !ROLE_TOKENS.has(t));
  // If every token is a role token, keep them all (otherwise the core is empty).
  const final = kept.length > 0 ? kept : tokens;
  return final.join("");
}

/**
 * True when `candidate` is related to `instance` by identity-core matching.
 *
 * - Root core >= MIN_CORE_LEN: prefix match (candidate core starts with root
 *   core, or vice-versa — either direction counts as related).
 * - Root core < MIN_CORE_LEN: exact core equality only (prevents 1-3 char roots
 *   from over-merging unrelated apps).
 *
 * Mirrors the Swift `PurgeCore.isRelated(_:to:)`.
 */
export function isRelated(candidate: string, instance: string): boolean {
  const rootCore = core(instance);
  const candCore = core(candidate);
  if (rootCore.length < MIN_CORE_LEN) {
    return candCore === rootCore;
  }
  return candCore.startsWith(rootCore) || rootCore.startsWith(candCore);
}

// ---------------------------------------------------------------------------
// Helm release detection
// ---------------------------------------------------------------------------

const HELM_SECRET_RE = /^sh\.helm\.release\.v1\.(.+)\.v\d+$/;

/**
 * Extract the helm release name from a Helm release secret name, or null if the
 * secret is not a `sh.helm.release.v1.<release>.v<N>` secret.
 */
export function helmReleaseFromSecretName(secretName: string): string | null {
  const m = HELM_SECRET_RE.exec(secretName);
  return m ? m[1] : null;
}

/**
 * Given the secret names in a namespace, find the helm release related to
 * `instance` by identity-core matching. Returns the release name or null.
 * Mirrors the Swift `PurgeDiscovery.detectHelmRelease`.
 */
export function detectHelmRelease(secretNames: string[], instance: string): string | null {
  for (const name of secretNames) {
    const release = helmReleaseFromSecretName(name);
    if (release && isRelated(release, instance)) return release;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Discovery filtering
// ---------------------------------------------------------------------------

/** A raw resource pulled from `kubectl get … -o json` (the items array). */
export interface RawResource {
  kind: string; // Kubernetes "kind" field, e.g. "Deployment"
  metadata: { name: string; namespace?: string };
}

/** A discovered resource surfaced to the client. */
export interface DiscoveredResource {
  kind: ResourceKind;
  name: string;
  namespace: string;
}

/**
 * Filter raw discovered resources down to those related to `instance`, applying
 * the workload core-prefix rule, the dependent loose-relation rule, and the
 * shared-infra guard.
 *
 * - Workloads (deployment/statefulset/daemonset): kept when `isRelated`, unless
 *   they are shared-infra workloads (postgres/redis/…), which are never deleted.
 * - Dependents (everything else): kept when `isRelated`.
 *
 * Helm release secrets (`sh.helm.release.v1.*`) are excluded from the delete
 * set — they are removed by `helm uninstall`, not a manual `kubectl delete`.
 *
 * Mirrors the Swift `PurgeDiscovery.filter`.
 */
export function filterDiscovered(
  raw: RawResource[],
  instance: string,
  namespace: string,
): DiscoveredResource[] {
  const out: DiscoveredResource[] = [];
  for (const r of raw) {
    const kind = canonicalKind(r.kind);
    if (!kind) continue;
    const name = r.metadata.name;

    // Never list helm bookkeeping secrets as individual deletes.
    if (kind === "secret" && helmReleaseFromSecretName(name) !== null) continue;

    if (!isRelated(name, instance)) continue;

    // Shared-infra workloads are protected: never propose them for deletion.
    if (WORKLOAD_KINDS.has(kind) && isSharedInfraWorkload(name)) continue;

    out.push({ kind, name, namespace });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Discovery query argv
// ---------------------------------------------------------------------------

/**
 * Build the kubectl argv (verb onward) for the discovery query. The caller
 * prepends `kubectl [--context <ctx>]`.
 *
 *   get <kinds> -l app.kubernetes.io/instance=<instance> -n <namespace> -o json
 */
export function discoveryArgs(instance: string, namespace: string): string[] {
  return [
    "get",
    DISCOVERY_KINDS.join(","),
    "-l",
    `app.kubernetes.io/instance=${instance}`,
    "-n",
    namespace,
    "-o",
    "json",
  ];
}

/**
 * Build the kubectl argv (verb onward) for the name-prefix fallback query (used
 * when the instance label match yields nothing). The caller prepends
 * `kubectl [--context <ctx>]`.
 *
 *   get <kinds> -n <namespace> -o json
 *
 * Name-relation filtering is applied in post-processing via `filterDiscovered`.
 */
export function fallbackDiscoveryArgs(namespace: string): string[] {
  return ["get", DISCOVERY_KINDS.join(","), "-n", namespace, "-o", "json"];
}

/** Build the kubectl argv for deleting one resource (caller prepends kubectl). */
export function deleteArgs(kind: ResourceKind, name: string, namespace: string): string[] {
  return ["delete", kubectlDeleteKind(kind), name, "-n", namespace];
}

/** Build the helm argv for uninstalling a release (caller prepends helm). */
export function helmUninstallArgs(release: string, namespace: string): string[] {
  return ["uninstall", release, "-n", namespace];
}
