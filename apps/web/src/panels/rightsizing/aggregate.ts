// Glue layer: turn live workload specs (Zustand store) + current pod metrics
// (/api/metrics/pods) into per-container WindowStats and WorkloadRightSizing
// rows. Pure functions — no I/O.
//
// The web port has no persistent SQLite history yet, so it tracks an in-memory
// rolling sample window keyed by (namespace, workload, container). Each poll
// folds a fresh sample in; peak/typical/hoursCovered are derived from the
// accumulated samples. Until ~24h of samples exist, verdicts read
// "Gathering data" (insufficientData) — matching the Swift warming-up state.

import {
  analyzeContainer,
  parseQuantity,
  summarizeWorkload,
} from "./displayHelper";
import type {
  ContainerResources,
  WindowStats,
  WorkloadKind,
  WorkloadRightSizing,
} from "./types";

/** One row from GET /api/metrics/pods. */
export interface PodMetric {
  namespace: string;
  name: string;
  cpu: string; // millicores numeric string
  memory: string; // "<n>Mi"
}

/** Minimal shape of a workload object from the store (deploy/sts/ds). */
export interface WorkloadObject {
  metadata: { name: string; namespace?: string };
  spec?: {
    template?: {
      spec?: {
        containers?: Array<{
          name: string;
          resources?: {
            requests?: Record<string, string>;
            limits?: Record<string, string>;
          };
        }>;
      };
    };
  };
}

/** Parse a container's spec resources into cores/bytes. */
export function containerResources(c: {
  name: string;
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
}): ContainerResources {
  const req = c.resources?.requests ?? {};
  const lim = c.resources?.limits ?? {};
  const num = (m: Record<string, string>, k: string, t: "cpu" | "memory") =>
    m[k] != null ? parseQuantity(m[k], t) : undefined;
  return {
    container: c.name,
    cpuRequest: num(req, "cpu", "cpu"),
    cpuLimit: num(lim, "cpu", "cpu"),
    memRequest: num(req, "memory", "memory"),
    memLimit: num(lim, "memory", "memory"),
  };
}

/** Does a pod name belong to this workload? Matches the Swift `<name>-*` rule. */
export function podBelongsTo(podName: string, workloadName: string): boolean {
  return podName === workloadName || podName.startsWith(`${workloadName}-`);
}

// --- Rolling sample accumulator --------------------------------------------

interface Sample {
  cpu: number; // cores
  mem: number; // bytes
  t: number; // epoch ms
}

/** Per-key accumulator: keyed "<ns>/<workload>" → recent samples. */
export type SampleStore = Map<string, Sample[]>;

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function aggKey(ns: string, workload: string): string {
  return `${ns}/${workload}`;
}

/** Sum pod metrics belonging to one workload at this instant → one sample. */
function instantSample(
  metrics: PodMetric[],
  ns: string,
  workload: string,
  now: number,
): Sample | null {
  let cpu = 0;
  let mem = 0;
  let matched = false;
  for (const m of metrics) {
    if (m.namespace !== ns) continue;
    if (!podBelongsTo(m.name, workload)) continue;
    matched = true;
    cpu += Number(m.cpu) / 1000; // millicores → cores
    mem += Number(m.memory.replace(/Mi$/, "")) * 1024 * 1024; // Mi → bytes
  }
  return matched ? { cpu, mem, t: now } : null;
}

/**
 * Fold the current poll into the sample store (mutates + returns it), evicting
 * samples older than the 30-day window.
 */
export function ingestSamples(
  store: SampleStore,
  metrics: PodMetric[],
  workloads: Array<{ namespace: string; name: string }>,
  now: number = Date.now(),
): SampleStore {
  for (const w of workloads) {
    const s = instantSample(metrics, w.namespace, w.name, now);
    if (!s) continue;
    const key = aggKey(w.namespace, w.name);
    const arr = store.get(key) ?? [];
    arr.push(s);
    // Evict stale samples.
    const cutoff = now - WINDOW_MS;
    store.set(
      key,
      arr.filter((x) => x.t >= cutoff),
    );
  }
  return store;
}

/** p95 of a numeric array (nearest-rank). Empty → 0. */
function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil(0.95 * sorted.length) - 1,
  );
  return sorted[Math.max(0, idx)];
}

/**
 * Aggregate the accumulated samples for one workload into WindowStats. We have
 * no per-container breakdown from `kubectl top pods`, so every container in a
 * workload shares the workload-level usage (correct for the common
 * single-container case; an upper bound otherwise).
 *
 * hoursCovered is derived from the observed sample time-span (distinct hours),
 * so verdicts stay "Gathering data" until ~24h of real history accumulates —
 * matching the Swift warming-up behavior.
 */
export function windowStatsFor(
  store: SampleStore,
  ns: string,
  workload: string,
  container: string,
): WindowStats {
  const samples = store.get(aggKey(ns, workload)) ?? [];
  if (samples.length === 0) {
    return {
      container,
      cpuPeak: 0,
      cpuTypical: 0,
      memPeak: 0,
      memTypical: 0,
      hoursCovered: 0,
    };
  }
  const cpus = samples.map((s) => s.cpu);
  const mems = samples.map((s) => s.mem);
  const hours = new Set(samples.map((s) => Math.floor(s.t / (60 * 60 * 1000))));
  return {
    container,
    cpuPeak: Math.max(...cpus),
    cpuTypical: p95(cpus),
    memPeak: Math.max(...mems),
    memTypical: p95(mems),
    hoursCovered: hours.size,
  };
}

const KIND_MAP: Record<string, WorkloadKind> = {
  deployments: "deployment",
  statefulsets: "statefulset",
  daemonsets: "daemonset",
};

/**
 * Build WorkloadRightSizing rows from store workloads + accumulated samples.
 *
 * @param byKind  store resource maps keyed by watch-kind
 *                ("deployments"|"statefulsets"|"daemonsets")
 */
export function buildRightSizing(
  byKind: Record<string, Record<string, WorkloadObject>>,
  store: SampleStore,
): WorkloadRightSizing[] {
  const out: WorkloadRightSizing[] = [];
  for (const [watchKind, kind] of Object.entries(KIND_MAP)) {
    const objs = byKind[watchKind] ?? {};
    for (const obj of Object.values(objs)) {
      const ns = obj.metadata.namespace ?? "default";
      const name = obj.metadata.name;
      const containers = obj.spec?.template?.spec?.containers ?? [];
      if (containers.length === 0) continue;
      const results = containers.map((c) =>
        analyzeContainer(
          containerResources(c),
          windowStatsFor(store, ns, name, c.name),
        ),
      );
      out.push(summarizeWorkload(kind, name, ns, results));
    }
  }
  return out;
}
