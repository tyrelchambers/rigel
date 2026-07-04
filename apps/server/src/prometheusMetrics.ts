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
import {
  type UsageRow,
  usageQueries,
  mergeUsage,
} from "@rigel/k8s/src/usage";

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
  usageQueries,
  mergeUsage,
};

/** Matches the install scrape_interval (60s); used to estimate hours of history. */
const SCRAPE_INTERVAL_SECONDS = 60;

/** Per-(namespace, pod, container) aggregate usage over the window. Moved to
 *  @rigel/k8s/src/usage (shared with the web right-sizing panel and the audit
 *  CLI's performance audit) as `UsageRow`; aliased here so existing importers
 *  of this module keep working unchanged. */
export type PodUsage = UsageRow;

export interface UsageResult {
  available: boolean;
  backend: PromBackend | null;
  items: PodUsage[];
}

/** The single best backend (auto-detect default). */
export function detectBackendFromServices(services: ServiceJson[]): PromBackend | null {
  return pickBackend(detectAllBackendsFromServices(services));
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
