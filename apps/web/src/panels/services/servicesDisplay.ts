import type { Service, ServicePort } from "./types";
import type { Pod } from "../pods/types";

/**
 * Pure display helpers for the Services panel. Mirrors the Swift `Service`
 * computed properties (`portSummaries`, `externalAddress`, `isExternalName`)
 * and `ServicesViewModel` derivations. See `docs/parity/services.md`.
 */

// Re-export the shared relativeAge so the panel imports one age formatter.
export { relativeAge } from "../pods/podDisplay";

/** `spec.type` or the Kubernetes default "ClusterIP". */
export function typeLabel(service: Service): string {
  return service.spec?.type ?? "ClusterIP";
}

/** True for ExternalName services (no clusterIP / endpoints). */
export function isExternalName(service: Service): boolean {
  return typeLabel(service) === "ExternalName";
}

/**
 * Format a single port. Mirrors Swift `Service.portSummaries`:
 *   head  = nodePort ? `${port}:${nodePort}` : `${port}`
 *   arrow = targetPort && targetPort !== String(port) ? `→${targetPort}` : ""
 *   => `${head}${arrow}/${protocol ?? "TCP"}`
 * Examples: "80/TCP", "80→8080/TCP", "8080:30080→9090/TCP".
 */
export function portSummary(p: ServicePort): string {
  const head = p.nodePort != null ? `${p.port}:${p.nodePort}` : `${p.port}`;
  const target = p.targetPort != null ? String(p.targetPort) : undefined;
  const arrow = target != null && target !== String(p.port) ? `→${target}` : "";
  return `${head}${arrow}/${p.protocol ?? "TCP"}`;
}

/** Formatted summary for each port (empty array when there are no ports). */
export function portSummaries(ports: ServicePort[] | undefined): string[] {
  return (ports ?? []).map(portSummary);
}

/**
 * External address. Mirrors Swift `Service.externalAddress`, priority:
 *   1. LoadBalancer ingress IPs/hostnames (comma-separated)
 *   2. static spec.externalIPs (comma-separated)
 *   3. spec.externalName (single string)
 *   => null if none exist.
 */
export function externalAddress(service: Service): string | null {
  const lb = (service.status?.loadBalancer?.ingress ?? [])
    .map((e) => e.ip ?? e.hostname)
    .filter((v): v is string => !!v);
  if (lb.length > 0) return lb.join(", ");

  const ips = service.spec?.externalIPs;
  if (ips && ips.length > 0) return ips.join(", ");

  const ext = service.spec?.externalName;
  if (ext && ext.length > 0) return ext;

  return null;
}

/**
 * Endpoint count: number of pods in the service's namespace whose labels are a
 * superset of `spec.selector`. Returns `null` when the service has no selector
 * (headless / ExternalName). Mirrors `ServicesViewModel.endpointCount(for:)`
 * which calls `cache.pods(matchingLabels:in:)`.
 *
 * NOTE: the web store keys pods by `metadata.name` only, so the caller passes
 * the full pod list; we filter to the service namespace here.
 */
export function endpointCount(service: Service, pods: Pod[]): number | null {
  const selector = service.spec?.selector;
  if (!selector || Object.keys(selector).length === 0) return null;
  const ns = service.metadata.namespace;
  return pods.filter((pod) => {
    if (pod.metadata.namespace !== ns) return false;
    const labels = pod.metadata.labels ?? {};
    return Object.entries(selector).every(([k, v]) => labels[k] === v);
  }).length;
}

/**
 * Case-insensitive substring match across name, namespace, type label,
 * clusterIP, formatted port summaries, and selector `key=value` strings.
 * Empty/blank query matches everything. Mirrors `ServicesViewModel.filtered`.
 */
export function matchesSearch(service: Service, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;

  const fields: string[] = [
    service.metadata.name,
    service.metadata.namespace ?? "",
    typeLabel(service),
    service.spec?.clusterIP ?? "",
    ...portSummaries(service.spec?.ports),
    ...Object.entries(service.spec?.selector ?? {}).map(([k, v]) => `${k}=${v}`),
  ];

  return fields.some((f) => f.toLowerCase().includes(q));
}

/** Stable display sort: namespace, then name. */
export function sortServices(services: Service[]): Service[] {
  return [...services].sort((a, b) => {
    const ns = (a.metadata.namespace ?? "").localeCompare(b.metadata.namespace ?? "");
    if (ns !== 0) return ns;
    return a.metadata.name.localeCompare(b.metadata.name);
  });
}

/**
 * Long, humanized age from an ISO timestamp: "165 days", "1 hour", "3 minutes",
 * "just now". `—` when missing/invalid. Pass `now` for test determinism.
 * (Distinct from the compact `relativeAge` — this reads as words in the detail view.)
 */
export function humanAge(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const s = Math.max(0, Math.floor((now - then) / 1000));
  const units: [number, string][] = [
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [secs, label] of units) {
    if (s >= secs) {
      const n = Math.floor(s / secs);
      return `${n} ${label}${n === 1 ? "" : "s"}`;
    }
  }
  return "just now";
}
