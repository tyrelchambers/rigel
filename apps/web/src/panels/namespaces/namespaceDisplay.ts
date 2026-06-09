import type { Namespace } from "./types";
import type { Pod } from "../pods/types";

// Re-export the shared compact relative-age helper so the panel imports a
// single display module (mirrors NamespaceRow.ageString() in Swift).
export { relativeAge } from "../pods/podDisplay";

/** Phase shown for a namespace: status.phase, defaulting to "Active". */
export function phaseOf(ns: Namespace): string {
  return ns.status?.phase ?? "Active";
}

/**
 * Namespace phase → pill color class. Active=green, Terminating=yellow,
 * anything else (including a literal unknown phase) = muted gray.
 */
export function namespacePhaseColorClass(phase: string): string {
  switch (phase) {
    case "Active":
      return "bg-green-500/15 text-green-600 dark:text-green-400";
    case "Terminating":
      return "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400";
    default:
      return "bg-muted text-muted-foreground";
  }
}

/**
 * Count pods in a namespace, derived from a (possibly absent) pods watch.
 *
 * Returns a number when `pods` is provided (even 0), or `null` when the pods
 * watch is not subscribed — the caller renders "—" for null and "N pod(s)"
 * for a number. Namespaces panel never imposes a pods subscription.
 */
export function podCountInNamespace(ns: Namespace, pods: Pod[] | null): number | null {
  if (pods === null) return null;
  return pods.filter((p) => p.metadata.namespace === ns.metadata.name).length;
}

/** "1 pod" / "2 pods" / "0 pods", or "—" when pods are not subscribed. */
export function podCountLabel(count: number | null): string {
  if (count === null) return "—";
  return count === 1 ? "1 pod" : `${count} pods`;
}

/**
 * Case-insensitive substring match against the namespace name and phase.
 * Empty/blank query matches everything.
 */
export function matchesSearch(ns: Namespace, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  if (ns.metadata.name.toLowerCase().includes(q)) return true;
  if (phaseOf(ns).toLowerCase().includes(q)) return true;
  return false;
}

/** Lexicographic (case-sensitive ascending) sort by namespace name. */
export function sortNamespaces(namespaces: Namespace[]): Namespace[] {
  return [...namespaces].sort((a, b) =>
    a.metadata.name < b.metadata.name ? -1 : a.metadata.name > b.metadata.name ? 1 : 0,
  );
}

// --- DNS-1123 namespace name validation (client-side) -----------------------

/** DNS-1123 label: lowercase alphanumerics + hyphens, start/end alphanumeric. */
const DNS_1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/**
 * True when `name` is a valid Kubernetes namespace name (DNS-1123 label):
 * 1–63 chars, pattern `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`.
 */
export function isValidNamespaceName(name: string): boolean {
  if (name.length < 1 || name.length > 63) return false;
  return DNS_1123_LABEL.test(name);
}
