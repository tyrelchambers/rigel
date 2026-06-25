/**
 * Curated resource types for the `/describe` progressive picker, plus the pure
 * helpers that build each stage's options (type -> namespace -> instance).
 *
 * Kept free of React/lucide so the composer trigger logic and its unit tests can
 * import it without a DOM. Icons are referenced by a string `iconKey` that
 * PaneComposer maps to a lucide component (mirrors MENTION_ICON).
 */

export type DescribeScope = "namespaced" | "cluster";

export type DescribeIconKey =
  | "pod"
  | "deployment"
  | "service"
  | "ingress"
  | "secret"
  | "configmap"
  | "statefulset"
  | "daemonset"
  | "job"
  | "cronjob"
  | "pvc"
  | "node"
  | "namespace";

export interface DescribeKind {
  /** Watch/store kind (plural), e.g. "ingresses". */
  kind: string;
  /** Token inserted into the command (singular), e.g. "ingress". */
  singular: string;
  /** Display label for the type row. */
  label: string;
  scope: DescribeScope;
  iconKey: DescribeIconKey;
}

/** The curated set, in display order. All entries are server-watchable. */
export const DESCRIBE_KINDS: DescribeKind[] = [
  { kind: "pods", singular: "pod", label: "Pods", scope: "namespaced", iconKey: "pod" },
  { kind: "deployments", singular: "deployment", label: "Deployments", scope: "namespaced", iconKey: "deployment" },
  { kind: "services", singular: "service", label: "Services", scope: "namespaced", iconKey: "service" },
  { kind: "ingresses", singular: "ingress", label: "Ingresses", scope: "namespaced", iconKey: "ingress" },
  { kind: "secrets", singular: "secret", label: "Secrets", scope: "namespaced", iconKey: "secret" },
  { kind: "configmaps", singular: "configmap", label: "ConfigMaps", scope: "namespaced", iconKey: "configmap" },
  { kind: "statefulsets", singular: "statefulset", label: "StatefulSets", scope: "namespaced", iconKey: "statefulset" },
  { kind: "daemonsets", singular: "daemonset", label: "DaemonSets", scope: "namespaced", iconKey: "daemonset" },
  { kind: "jobs", singular: "job", label: "Jobs", scope: "namespaced", iconKey: "job" },
  { kind: "cronjobs", singular: "cronjob", label: "CronJobs", scope: "namespaced", iconKey: "cronjob" },
  { kind: "persistentvolumeclaims", singular: "pvc", label: "PersistentVolumeClaims", scope: "namespaced", iconKey: "pvc" },
  { kind: "nodes", singular: "node", label: "Nodes", scope: "cluster", iconKey: "node" },
  { kind: "namespaces", singular: "namespace", label: "Namespaces", scope: "cluster", iconKey: "namespace" },
];

/** A rendered row in any describe stage. */
export interface DescribeOption {
  /** Token selected/inserted: singular (type), namespace name, or instance name. */
  value: string;
  /** Primary display label. */
  label: string;
  /** Right-side badge text (scope for types, "NS", or the KIND for instances). */
  badge: string;
  iconKey: DescribeIconKey;
  /** Instance stage only: the resource's own namespace. */
  namespace?: string;
}

const SCOPE_BADGE: Record<DescribeScope, string> = { namespaced: "NS", cluster: "CLUSTER" };

/** Resolve a typed type token (singular or plural) to a curated kind. */
export function resolveDescribeKind(token: string): DescribeKind | undefined {
  const t = token.toLowerCase();
  return DESCRIBE_KINDS.find((k) => k.singular === t || k.kind === t);
}

export function isNamespaced(k: DescribeKind): boolean {
  return k.scope === "namespaced";
}

/**
 * Type-stage options: curated kinds filtered + ranked by the partial. The set is
 * small and bounded, so by default we show all of it (the popover scrolls).
 */
export function describeTypeOptions(query: string, limit = DESCRIBE_KINDS.length): DescribeOption[] {
  const q = query.toLowerCase();
  const matched = !q
    ? DESCRIBE_KINDS
    : DESCRIBE_KINDS.filter(
        (k) => k.singular.includes(q) || k.kind.includes(q) || k.label.toLowerCase().includes(q),
      ).sort((a, b) => rankKind(a, q) - rankKind(b, q));
  return matched.slice(0, limit).map((k) => ({
    value: k.singular,
    label: k.label,
    badge: SCOPE_BADGE[k.scope],
    iconKey: k.iconKey,
  }));
}

function rankKind(k: DescribeKind, q: string): number {
  if (k.singular === q || k.kind === q) return 0;
  if (k.singular.startsWith(q) || k.kind.startsWith(q)) return 1;
  if (k.label.toLowerCase().startsWith(q)) return 2;
  return 3;
}

interface NameMeta {
  metadata?: { name?: string; namespace?: string };
}

function valuesOf(resources: Record<string, unknown>, kind: string): NameMeta[] {
  return Object.values((resources[kind] ?? {}) as Record<string, NameMeta>);
}

/** Namespace-stage options: namespace names filtered by the partial. */
export function describeNamespaceOptions(
  resources: Record<string, unknown>,
  query: string,
  limit = 8,
): DescribeOption[] {
  const names = valuesOf(resources, "namespaces")
    .map((n) => n.metadata?.name)
    .filter((n): n is string => !!n);
  return rankNames(names, query.toLowerCase(), limit).map((name) => ({
    value: name,
    label: name,
    badge: "NS",
    iconKey: "namespace",
  }));
}

/**
 * Instance-stage options: instances of `k` in `namespace` (undefined namespace =
 * cluster-scoped, so no filtering), filtered + ranked by the name partial.
 */
export function describeInstanceOptions(
  resources: Record<string, unknown>,
  k: DescribeKind,
  namespace: string | undefined,
  query: string,
  limit = 8,
): DescribeOption[] {
  const items = valuesOf(resources, k.kind).flatMap((o) => {
    const name = o.metadata?.name;
    if (!name) return [];
    const ns = o.metadata?.namespace;
    if (namespace !== undefined && (ns ?? "default") !== namespace) return [];
    return [{ name, namespace: ns }];
  });
  return rankByName(items, query.toLowerCase(), limit).map((o) => ({
    value: o.name,
    label: o.name,
    badge: k.singular.toUpperCase(),
    iconKey: k.iconKey,
    namespace: o.namespace,
  }));
}

function scoreName(name: string, q: string): number {
  const n = name.toLowerCase();
  if (n === q) return 1000;
  if (n.startsWith(q)) return 500;
  if (n.includes(q)) return 200 - n.indexOf(q);
  return -1;
}

function rankNames(names: string[], q: string, limit: number): string[] {
  if (!q) return [...names].sort((a, b) => a.localeCompare(b)).slice(0, limit);
  return names
    .map((name) => ({ name, s: scoreName(name, q) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.name);
}

function rankByName<T extends { name: string }>(items: T[], q: string, limit: number): T[] {
  if (!q) return [...items].sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit);
  return items
    .map((it) => ({ it, s: scoreName(it.name, q) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.it);
}
