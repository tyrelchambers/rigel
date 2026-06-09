import type { Ingress, IngressRoute, ServiceBackendPort } from "./types";

/**
 * Pure display helpers for the Ingresses panel. Mirrors the Swift `Ingress`
 * computed properties (`className`, `isTLS`, `hosts`, `routes`, `address`,
 * `portLabel`) and `IngressesViewModel` filtering. See `docs/parity/ingresses.md`.
 */

// Re-export the shared relativeAge so the panel imports one age formatter.
export { relativeAge } from "../pods/podDisplay";

/** `spec.ingressClassName` or "—" when nil/empty. Mirrors `Ingress.className`. */
export function className(ingress: Ingress): string {
  const c = ingress.spec?.ingressClassName;
  return c && c.length > 0 ? c : "—";
}

/** True when `spec.tls` is non-empty. Mirrors `Ingress.isTLS`. */
export function isTLS(ingress: Ingress): boolean {
  return (ingress.spec?.tls?.length ?? 0) > 0;
}

/**
 * Unique, sorted list of hosts from all routing rules. Empty array when there
 * are no rules. Mirrors `Ingress.hosts`.
 */
export function hosts(ingress: Ingress): string[] {
  const set = new Set<string>();
  for (const rule of ingress.spec?.rules ?? []) {
    if (rule.host) set.add(rule.host);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * Format a backend port. Mirrors Swift `Ingress.portLabel`:
 *   number ? String(number) : (name ?? "")
 */
export function portLabel(port: ServiceBackendPort | undefined): string {
  if (port?.number != null) return String(port.number);
  return port?.name ?? "";
}

/**
 * Flatten all routing rules into `(host, path, service, port)` tuples. Includes
 * the default backend (host="*", path="/") if present. Mirrors `Ingress.routes`.
 */
export function flattenRoutes(ingress: Ingress): IngressRoute[] {
  const out: IngressRoute[] = [];
  for (const rule of ingress.spec?.rules ?? []) {
    for (const p of rule.http?.paths ?? []) {
      out.push({
        host: rule.host ?? "*",
        path: p.path ?? "/",
        service: p.backend.service?.name ?? "—",
        port: portLabel(p.backend.service?.port),
      });
    }
  }
  const def = ingress.spec?.defaultBackend?.service;
  if (def) {
    out.push({ host: "*", path: "/", service: def.name, port: portLabel(def.port) });
  }
  return out;
}

/**
 * External address(es) assigned by the ingress controller's load balancer.
 * Per entry, IP takes priority over hostname; multiple entries are joined by
 * ", ". Returns null when none are assigned. Mirrors `Ingress.address`.
 */
export function externalAddress(ingress: Ingress): string | null {
  const parts = (ingress.status?.loadBalancer?.ingress ?? [])
    .map((e) => e.ip ?? e.hostname)
    .filter((v): v is string => !!v);
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Case-insensitive substring match across name, namespace, ingress class,
 * all hosts, and all backend service names. Empty/blank query matches
 * everything. Mirrors `IngressesViewModel.filtered`.
 */
export function matchesSearch(ingress: Ingress, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;

  const serviceNames = flattenRoutes(ingress).map((r) => r.service);
  const fields: string[] = [
    ingress.metadata.name,
    ingress.metadata.namespace ?? "",
    className(ingress),
    ...hosts(ingress),
    ...serviceNames,
  ];

  return fields.some((f) => f.toLowerCase().includes(q));
}

/** Stable display sort: namespace, then name. */
export function sortIngresses(ingresses: Ingress[]): Ingress[] {
  return [...ingresses].sort((a, b) => {
    const ns = (a.metadata.namespace ?? "").localeCompare(b.metadata.namespace ?? "");
    if (ns !== 0) return ns;
    return a.metadata.name.localeCompare(b.metadata.name);
  });
}
