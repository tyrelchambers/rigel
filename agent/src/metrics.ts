// agent/src/metrics.ts
// Collects a per-node CPU%/memory% snapshot for metricThreshold alert rules,
// querying the auto-detected Prometheus/VictoriaMetrics backend through the
// API-server service proxy (kubectl get --raw). Uses the in-cluster
// ServiceAccount token (agent kubectl takes no --context). Only runs when at
// least one enabled metricThreshold rule exists and a backend is present.

import { kubectl } from "./kubectl.js";
import { type AlertRule, type MetricSnapshot } from "./alerts.js";
import {
  detectAllBackendsFromServices,
  pickBackend,
  proxyBase,
  promEncode,
  parsePromInstant,
  seriesToNodeMap,
  nodeCpuPercentQuery,
  nodeMemoryPercentQuery,
  type PromBackend,
  type ServiceJson,
} from "@rigel/k8s/src/prometheus.js";

const empty = (): MetricSnapshot => ({ cpuPercentByNode: {}, memoryPercentByNode: {} });
const REDETECT_MS = 5 * 60_000;

let cachedBackend: PromBackend | null | undefined; // undefined = never detected
let lastDetectMs = 0;

/** Detect (and cache) the metrics backend from cluster Services. Re-detects at
 * most every REDETECT_MS; on a kubectl failure keeps the previous cache. */
export async function resolveBackend(now: number): Promise<PromBackend | null> {
  if (cachedBackend !== undefined && now - lastDetectMs < REDETECT_MS) return cachedBackend ?? null;
  try {
    const res = await kubectl(["get", "services", "--all-namespaces", "-o", "json"]);
    if (res.code === 0) {
      const json = JSON.parse(res.stdout) as { items?: ServiceJson[] };
      const items = Array.isArray(json.items) ? json.items : [];
      cachedBackend = pickBackend(detectAllBackendsFromServices(items));
      lastDetectMs = now;
    }
  } catch {
    // kubectl spawn error or malformed output — keep whatever we had
  }
  return cachedBackend ?? null;
}

async function instantQuery(base: string, promql: string) {
  const path = `${base}/api/v1/query?query=${promEncode(promql)}`;
  try {
    const res = await kubectl(["get", "--raw", path]);
    if (res.code !== 0) return [];
    return parsePromInstant(res.stdout);
  } catch {
    return [];
  }
}

async function queryNodeMetric(
  backend: PromBackend, metric: "cpuPercent" | "memoryPercent",
): Promise<Record<string, number>> {
  const q = metric === "cpuPercent" ? nodeCpuPercentQuery() : nodeMemoryPercentQuery();
  return seriesToNodeMap(await instantQuery(proxyBase(backend), q));
}

/** Snapshot of node CPU%/memory% needed by the enabled metricThreshold rules.
 * Empty when there are no metric rules or no backend (metric rules then simply
 * don't fire; health rules are unaffected). */
export async function collectMetricSnapshot(rules: AlertRule[], now: number): Promise<MetricSnapshot> {
  const metricRules = rules.filter((r) => r.enabled && r.condition.type === "metricThreshold");
  if (metricRules.length === 0) return empty();
  const backend = await resolveBackend(now);
  if (!backend) return empty();
  const needCpu = metricRules.some((r) => r.condition.type === "metricThreshold" && r.condition.metric === "cpuPercent");
  const needMem = metricRules.some((r) => r.condition.type === "metricThreshold" && r.condition.metric === "memoryPercent");
  const [cpuPercentByNode, memoryPercentByNode] = await Promise.all([
    needCpu ? queryNodeMetric(backend, "cpuPercent") : Promise.resolve({}),
    needMem ? queryNodeMetric(backend, "memoryPercent") : Promise.resolve({}),
  ]);
  return { cpuPercentByNode, memoryPercentByNode };
}
