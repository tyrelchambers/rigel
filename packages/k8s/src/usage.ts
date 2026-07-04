// packages/k8s/src/usage.ts
// Runner-agnostic usage-history helpers shared by the web right-sizing panel,
// the server's Prometheus/VictoriaMetrics route, and the audit CLI's
// performance audit. Ported verbatim from the web's
// apps/web/src/panels/rightsizing/aggregate.ts (windowStatsFromUsage,
// podBelongsTo) and apps/server/src/prometheusMetrics.ts (usageQueries,
// mergeUsage) so all three share ONE implementation. No kubectl here directly —
// `fetchUsage` takes a caller-supplied runner (server's `kubectl()` bound to a
// context, or the CLI's KubectlRunner) so it stays unit-testable without a
// cluster.
import { proxyBase, promEncode, parsePromInstant, type PromBackend, type PromSeries } from "./prometheus";

/** History window queried, matching the Swift source + right-sizing panel. */
const WINDOW = "30d";
/** Matches the install scrape_interval (60s); used to estimate hours of history. */
const SCRAPE_INTERVAL_SECONDS = 60;

/** Per-(namespace, pod, container) aggregate usage over the window. */
export interface UsageRow {
  namespace: string;
  pod: string;
  container: string;
  cpuPeak: number; // cores
  cpuTypical: number; // cores
  memPeak: number; // bytes
  memTypical: number; // bytes
  hoursCovered: number;
}

/** Per-(namespace, workload, container) peak/typical usage over the window —
 *  structurally identical to the web's `WindowStats` (apps/web/src/panels/
 *  rightsizing/types.ts); kept as a separate type here so this module has no
 *  web dependency. */
export interface UsageWindowStats {
  container: string;
  cpuPeak: number; // cores
  cpuTypical: number; // cores
  memPeak: number; // bytes
  memTypical: number; // bytes
  hoursCovered: number;
}

/** Workload pod selector for the window queries. Adds the namespace when scoped. */
function selectorFor(namespace: string): string {
  const base = `container!="",container!="POD"`;
  return namespace && namespace !== "*" ? `namespace="${namespace}",${base}` : base;
}

/**
 * The five instant queries (order: memPeak, memTypical, cpuPeak, cpuTypical,
 * count), each grouped `by (namespace, pod, container)`. Verbatim shape from the
 * Swift `PrometheusMetricsSource`, batched across all pods rather than per
 * workload so this costs five queries total instead of five per workload.
 */
export function usageQueries(namespace: string): string[] {
  const sel = selectorFor(namespace);
  const g = "max by (namespace, pod, container)";
  return [
    `${g} (max_over_time(container_memory_working_set_bytes{${sel}}[${WINDOW}]))`,
    `${g} (quantile_over_time(0.95, container_memory_working_set_bytes{${sel}}[${WINDOW}]))`,
    `${g} (max_over_time(rate(container_cpu_usage_seconds_total{${sel}}[5m])[${WINDOW}:5m]))`,
    `${g} (quantile_over_time(0.95, rate(container_cpu_usage_seconds_total{${sel}}[5m])[${WINDOW}:5m]))`,
    `${g} (count_over_time(container_memory_working_set_bytes{${sel}}[${WINDOW}]))`,
  ];
}

export interface UsageQuerySet {
  memPeak: PromSeries[];
  memTypical: PromSeries[];
  cpuPeak: PromSeries[];
  cpuTypical: PromSeries[];
  count: PromSeries[];
}

/** Fold the five query results into one UsageRow per (namespace, pod, container). */
export function mergeUsage(q: UsageQuerySet, stepSeconds: number): UsageRow[] {
  const map = new Map<string, UsageRow>();
  const row = (m: Record<string, string>): UsageRow | null => {
    const { namespace, pod, container } = m;
    if (!namespace || !pod || !container) return null;
    const key = `${namespace}/${pod}/${container}`;
    let u = map.get(key);
    if (!u) {
      u = { namespace, pod, container, cpuPeak: 0, cpuTypical: 0, memPeak: 0, memTypical: 0, hoursCovered: 0 };
      map.set(key, u);
    }
    return u;
  };
  const val = (s: PromSeries): number => {
    const n = Number(s.value?.[1]);
    return Number.isFinite(n) ? n : 0;
  };
  for (const s of q.memPeak) { const u = row(s.metric); if (u) u.memPeak = val(s); }
  for (const s of q.memTypical) { const u = row(s.metric); if (u) u.memTypical = val(s); }
  for (const s of q.cpuPeak) { const u = row(s.metric); if (u) u.cpuPeak = val(s); }
  for (const s of q.cpuTypical) { const u = row(s.metric); if (u) u.cpuTypical = val(s); }
  for (const s of q.count) { const u = row(s.metric); if (u) u.hoursCovered = Math.round((val(s) * stepSeconds) / 3600); }
  return [...map.values()];
}

/** Does a pod name belong to this workload? Matches the Swift `<name>-*` rule. */
export function podBelongsTo(podName: string, workloadName: string): boolean {
  return podName === workloadName || podName.startsWith(`${workloadName}-`);
}

/**
 * Window stats for one workload/container from usage rows: the worst-case
 * across the workload's pods (peak = max, typical = max of per-pod p95,
 * hours = max), matching the Swift `max by (container)` aggregation.
 */
export function windowStatsFromUsage(
  rows: UsageRow[],
  ns: string,
  workload: string,
  container: string,
): UsageWindowStats {
  let matched = false;
  let cpuPeak = 0;
  let cpuTypical = 0;
  let memPeak = 0;
  let memTypical = 0;
  let hoursCovered = 0;
  for (const r of rows) {
    if (r.namespace !== ns || r.container !== container) continue;
    if (!podBelongsTo(r.pod, workload)) continue;
    matched = true;
    cpuPeak = Math.max(cpuPeak, r.cpuPeak);
    cpuTypical = Math.max(cpuTypical, r.cpuTypical);
    memPeak = Math.max(memPeak, r.memPeak);
    memTypical = Math.max(memTypical, r.memTypical);
    hoursCovered = Math.max(hoursCovered, r.hoursCovered);
  }
  return { container, cpuPeak, cpuTypical, memPeak, memTypical, hoursCovered: matched ? hoursCovered : 0 };
}

/** Minimal runner shape needed to fetch usage — matches both the server's
 *  `(args) => kubectl(context, args)` and the audit CLI's `KubectlRunner`. */
export type UsageKubectlRunner = (args: string[]) => Promise<string>;

/**
 * Run the five usage instant-queries through the API-server proxy for a given
 * backend + namespace scope ("*" for all namespaces), returning merged rows.
 * A failing individual query degrades to an empty result for that query rather
 * than failing the whole fetch (matches the server's `instantQuery` behavior).
 */
export async function fetchUsage(
  runner: UsageKubectlRunner,
  backend: PromBackend,
  namespace: string,
): Promise<UsageRow[]> {
  const base = proxyBase(backend);
  const runQuery = async (promql: string): Promise<PromSeries[]> => {
    const path = `${base}/api/v1/query?query=${promEncode(promql)}`;
    try {
      const stdout = await runner(["get", "--raw", path]);
      return parsePromInstant(stdout);
    } catch {
      return [];
    }
  };
  const [memPeak, memTypical, cpuPeak, cpuTypical, count] = await Promise.all(
    usageQueries(namespace).map(runQuery),
  );
  return mergeUsage({ memPeak, memTypical, cpuPeak, cpuTypical, count }, SCRAPE_INTERVAL_SECONDS);
}
