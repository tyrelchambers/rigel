// Pure helpers for the PurgePickerSheet. The protected-namespace list mirrors
// the server guardrail in @rigel/k8s/src/purge (kept in sync by the parity
// spec; the picker filters client-side so protected namespaces never appear,
// and the server re-checks at discovery + execution).

import type { Deployment } from "@/panels/deployments/types";

const PROTECTED_NAMESPACES = new Set([
  "kube-system",
  "kube-public",
  "kube-node-lease",
  "default-system",
  "cert-manager",
  "cnpg-system",
]);

const PROTECTED_NAMESPACE_PREFIXES = ["kube-", "cattle-", "fleet-", "tigera-", "calico-"];

/** True when a namespace can be purged (not protected). */
export function isPurgeableNamespace(namespace: string): boolean {
  if (PROTECTED_NAMESPACES.has(namespace)) return false;
  if (PROTECTED_NAMESPACE_PREFIXES.some((p) => namespace.startsWith(p))) return false;
  return true;
}

export interface NamespaceGroup {
  namespace: string;
  deployments: string[]; // names, sorted
}

/**
 * Group deployments by namespace, filtered by a case-insensitive search that
 * matches the deployment name OR the namespace substring. Namespaces and names
 * are returned sorted; empty groups are retained (caller may filter them).
 */
export function groupDeploymentsByNamespace(
  deployments: Deployment[],
  search: string,
): NamespaceGroup[] {
  const q = search.trim().toLowerCase();
  const byNs = new Map<string, string[]>();

  for (const d of deployments) {
    const ns = d.metadata.namespace ?? "default";
    const name = d.metadata.name;
    const matches =
      q === "" || name.toLowerCase().includes(q) || ns.toLowerCase().includes(q);
    if (!matches) continue;
    const list = byNs.get(ns) ?? [];
    list.push(name);
    byNs.set(ns, list);
  }

  return [...byNs.entries()]
    .map(([namespace, names]) => ({
      namespace,
      deployments: [...names].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.namespace.localeCompare(b.namespace));
}
