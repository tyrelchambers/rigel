/**
 * useMetricsHistory — accumulates point-in-time pod metrics into bounded
 * per-pod ring buffers and exposes sparkline series + current values.
 *
 * Polls GET /api/metrics/pods?namespace=<ns|*> via TanStack Query every 5s.
 * Each successful poll appends the CPU (millicores) and memory (MiB) reading
 * for every pod into its ring buffer (capped at RING_SIZE samples). When
 * metrics-server is unavailable the hook returns empty histories with
 * `available: false` — callers render "—" gracefully.
 */
import { useEffect, useRef } from "react";
import { useCluster } from "@/store/cluster";
import { usePodMetrics } from "./api";

const RING_SIZE = 30;

export interface PodMetricsEntry {
  cpuSeries: number[];
  memSeries: number[];
  cpuNow: number;
  memNow: number;
}

/** Map from "namespace/name" pod key to its history entry. */
export type MetricsHistoryMap = Map<string, PodMetricsEntry>;

export interface UseMetricsHistoryResult {
  available: boolean;
  history: MetricsHistoryMap;
}

function podKey(namespace: string | undefined, name: string): string {
  return `${namespace ?? ""}/${name}`;
}

function appendRing(ring: number[], value: number, maxSize: number): number[] {
  const next = [...ring, value];
  return next.length > maxSize ? next.slice(next.length - maxSize) : next;
}

/**
 * Hook: polls pod metrics for the active namespace and accumulates a ring
 * buffer of the last `RING_SIZE` samples per pod.
 */
export function useMetricsHistory(): UseMetricsHistoryResult {
  const namespaceFilter = useCluster((s) => s.namespaceFilter);
  const ns = namespaceFilter ?? "*";

  // The ring-buffer map persists across re-renders. We use a ref so that
  // mutations don't trigger their own re-renders (the parent re-renders on
  // the TanStack Query data change which triggers this hook anyway).
  const historyRef = useRef<MetricsHistoryMap>(new Map());

  const { data, isError } = usePodMetrics(ns);

  useEffect(() => {
    if (!data?.available || !data.items) return;

    const history = historyRef.current;
    for (const item of data.items) {
      const key = podKey(item.namespace, item.name);
      const prev = history.get(key) ?? {
        cpuSeries: [],
        memSeries: [],
        cpuNow: 0,
        memNow: 0,
      };
      history.set(key, {
        cpuSeries: appendRing(prev.cpuSeries, item.cpu, RING_SIZE),
        memSeries: appendRing(prev.memSeries, item.memory, RING_SIZE),
        cpuNow: item.cpu,
        memNow: item.memory,
      });
    }
  }, [data]);

  const available = !isError && (data?.available ?? false);

  return {
    available,
    history: historyRef.current,
  };
}
