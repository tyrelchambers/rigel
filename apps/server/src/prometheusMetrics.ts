/**
 * Right-sizing usage history from a Prometheus-compatible backend
 * (Prometheus or VictoriaMetrics), reached through the API-server proxy.
 *
 * Ports the Swift `PrometheusMetricsSource` + `MetricsBackendDetector`
 * (Sources/Rigel/Metrics/). The web port previously had only an in-memory,
 * per-browser-session sample accumulator — which reset on every reload and so
 * never reached the 24h needed for verdicts. When a metrics DB is present we
 * read 30 days of real history from it instead.
 *
 * All queries go through `kubectl get --raw <proxy>` (same primitive as
 * getNodeDisk), so the metrics DB needs no direct network exposure.
 */

import { kubectl } from "@rigel/k8s/src/run";
import {
  type PromBackend,
  type PromSeries,
  type ServiceJson,
  flavorForPort,
  detectAllBackendsFromServices,
  pickBackend,
  proxyBase,
  promEncode,
  parsePromInstant,
} from "@rigel/k8s/src/prometheus";

// Re-export so existing importers of this module keep working unchanged.
export {
  type PromBackend,
  type PromSeries,
  flavorForPort,
  detectAllBackendsFromServices,
  pickBackend,
  proxyBase,
  promEncode,
  parsePromInstant,
};

/** Matches the install scrape_interval (60s); used to estimate hours of history. */
const SCRAPE_INTERVAL_SECONDS = 60;
/** History window queried, matching the Swift source. */
const WINDOW = "30d";

/** Per-(namespace, pod, container) aggregate usage over the window. */
export interface PodUsage {
  namespace: string;
  pod: string;
  container: string;
  cpuPeak: number; // cores
  cpuTypical: number; // cores
  memPeak: number; // bytes
  memTypical: number; // bytes
  hoursCovered: number;
}

export interface UsageResult {
  available: boolean;
  backend: PromBackend | null;
  items: PodUsage[];
}

/** The single best backend (auto-detect default). */
export function detectBackendFromServices(services: ServiceJson[]): PromBackend | null {
  return pickBackend(detectAllBackendsFromServices(services));
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
 * workload so the panel costs five queries total instead of five per workload.
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

interface UsageQuerySet {
  memPeak: PromSeries[];
  memTypical: PromSeries[];
  cpuPeak: PromSeries[];
  cpuTypical: PromSeries[];
  count: PromSeries[];
}

/** Fold the five query results into one PodUsage row per (namespace, pod, container). */
export function mergeUsage(q: UsageQuerySet, stepSeconds: number): PodUsage[] {
  const map = new Map<string, PodUsage>();
  const row = (m: Record<string, string>): PodUsage | null => {
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

/** All metrics backends in the cluster (for the source picker). [] when none. */
export async function detectAllBackends(context: string | null): Promise<PromBackend[]> {
  // Retry on FAILURE only (non-zero exit or throw) — a cold-start/transient
  // kubectl hiccup must not read as "no backend" when one actually exists. A
  // successful-but-empty result (code 0, no matching services) is returned as-is.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await kubectl(context, ["get", "services", "--all-namespaces", "-o", "json"]);
      if (res.code === 0) {
        const json = JSON.parse(res.stdout) as { items?: ServiceJson[] };
        return detectAllBackendsFromServices(Array.isArray(json.items) ? json.items : []);
      }
      console.warn(
        `[metrics] backend detection: kubectl get services failed (code ${res.code}, attempt ${attempt}/3): ${res.stderr.trim().slice(0, 200)}`,
      );
    } catch (err) {
      console.warn(`[metrics] backend detection error (attempt ${attempt}/3): ${String(err)}`);
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 250 * attempt));
  }
  console.warn("[metrics] backend detection gave up after 3 attempts — reporting no backend");
  return [];
}

/** Detect the single best metrics backend. Null when none. */
export async function detectBackend(context: string | null): Promise<PromBackend | null> {
  return pickBackend(await detectAllBackends(context));
}

/** Run one instant query through the API-server proxy. Empty on any failure. */
async function instantQuery(context: string | null, base: string, promql: string): Promise<PromSeries[]> {
  const path = `${base}/api/v1/query?query=${promEncode(promql)}`;
  try {
    const res = await kubectl(context, ["get", "--raw", path]);
    if (res.code !== 0) {
      console.warn(`[usage] prometheus query failed (${res.code}): ${res.stderr.trim().slice(0, 200)}`);
      return [];
    }
    return parsePromInstant(res.stdout);
  } catch (err) {
    console.warn(`[usage] prometheus query error: ${String(err)}`);
    return [];
  }
}

/**
 * 30-day per-pod/container usage history for right-sizing. Detects a metrics
 * backend; returns `{ available:false }` (HTTP-200 graceful, like the other
 * metrics endpoints) when none is present so the panel falls back to its
 * in-session sampler.
 */
export async function getUsageHistory(
  context: string | null,
  namespace: string | undefined,
  explicitBackend?: PromBackend,
): Promise<UsageResult> {
  const ns = namespace ?? "*";
  // An explicit backend (picked in the UI) skips detection; otherwise auto-detect.
  const backend = explicitBackend ?? (await detectBackend(context));
  if (!backend) return { available: false, backend: null, items: [] };

  const base = proxyBase(backend);
  const [memPeak, memTypical, cpuPeak, cpuTypical, count] = await Promise.all(
    usageQueries(ns).map((q) => instantQuery(context, base, q)),
  );
  const items = mergeUsage({ memPeak, memTypical, cpuPeak, cpuTypical, count }, SCRAPE_INTERVAL_SECONDS);
  return { available: true, backend, items };
}
