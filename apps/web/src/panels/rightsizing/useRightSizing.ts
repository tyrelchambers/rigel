// Shared right-sizing data pipeline — subscribe to the workload kinds, pull
// 30-day usage history from the chosen (or auto-detected) Prometheus/
// VictoriaMetrics backend, and build per-workload WorkloadRightSizing rows
// (with reclaimableMemBytes). Consumed by BOTH the Right-Sizing panel and the
// Overview "Reclaimable" card so there is ONE fetch/compute path, not two.
import { useEffect, useMemo, useState } from "react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { buildRightSizing, windowStatsFromUsage, type UsageRow, type WorkloadObject } from "./aggregate";
import type { WorkloadRightSizing } from "./types";
import { loadBackendChoice, saveBackendChoice, type BackendChoice } from "./backendChoice";

export interface UsageBackend {
  flavor: string;
  namespace: string;
  service: string;
  port: number;
}

export interface UsageResponse {
  available: boolean;
  backend: UsageBackend | null;
  items: UsageRow[];
}

// Single-context web app → bucket the backend choice under "default" (Settings parity).
const CHOICE_CONTEXT = "default";

export async function fetchUsageHistory(namespace: string, backend?: UsageBackend): Promise<UsageResponse> {
  const params = new URLSearchParams({ namespace });
  if (backend) {
    params.set("bns", backend.namespace);
    params.set("svc", backend.service);
    params.set("port", String(backend.port));
  }
  const res = await fetch(`/api/metrics/usage?${params.toString()}`);
  if (!res.ok) throw new Error(`usage fetch failed: ${res.status}`);
  return res.json();
}

export async function fetchBackends(): Promise<UsageBackend[]> {
  try {
    const res = await fetch("/api/metrics/backends");
    if (!res.ok) return [];
    const j = (await res.json()) as { backends?: UsageBackend[] };
    return Array.isArray(j.backends) ? j.backends : [];
  } catch {
    return [];
  }
}

export interface RightSizingData {
  /** Per-workload recommendations across the current namespace scope. */
  workloads: WorkloadRightSizing[];
  /** Raw usage response: null while the first query is in flight. */
  usage: UsageResponse | null;
  /** First usage query still resolving. */
  detecting: boolean;
  /** A metrics backend is connected and returning data. */
  usingBackend: boolean;
  /** Resolved, but no backend is available. */
  noBackend: boolean;
  /** Detected backends (for the source picker). */
  backends: UsageBackend[];
  /** Current backend choice (auto or explicit). */
  choice: BackendChoice;
  /** Set + persist the backend choice. */
  setChoice: (c: BackendChoice) => void;
  /** Force a re-detect + re-fetch (e.g. after installing a backend). */
  reload: () => void;
}

/**
 * Resolve the namespace scope for the right-sizing queries. `clusterWide`
 * forces "*" (every namespace) regardless of the bar selection — the Overview
 * "Reclaimable" card uses this so it stays cluster-wide like the rest of the
 * dashboard, while the Right-Sizing panel leaves it off to honor the filter.
 */
export function resolveNamespaceScope(namespaceFilter: string | null, clusterWide: boolean): string {
  return clusterWide ? "*" : namespaceFilter ?? "*";
}

export function useRightSizing(opts?: { clusterWide?: boolean }): RightSizingData {
  const clusterWide = opts?.clusterWide ?? false;
  const resources = useCluster((s) => s.resources);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);

  const [choice, setChoiceState] = useState<BackendChoice>(() => loadBackendChoice(CHOICE_CONTEXT));
  const [backends, setBackends] = useState<UsageBackend[]>([]);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Workload specs come from the live store.
  useEffect(() => {
    const ns = resolveNamespaceScope(namespaceFilter, clusterWide);
    subscribe("deployments", ns);
    subscribe("statefulsets", ns);
    subscribe("daemonsets", ns);
    return () => {
      unsubscribe("deployments", ns);
      unsubscribe("statefulsets", ns);
      unsubscribe("daemonsets", ns);
    };
  }, [namespaceFilter, clusterWide]);

  // Detected backends for the picker.
  useEffect(() => {
    let cancelled = false;
    fetchBackends().then((b) => {
      if (!cancelled) setBackends(b);
    });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // Usage history from the chosen (or auto-detected) backend — the ONLY data
  // source. `usage === null` means "still resolving"; refreshed every 2 min.
  useEffect(() => {
    let cancelled = false;
    const ns = resolveNamespaceScope(namespaceFilter, clusterWide);
    const explicit =
      choice.kind === "prometheus"
        ? { flavor: choice.flavor, namespace: choice.namespace, service: choice.service, port: choice.port }
        : undefined;
    setUsage(null);
    async function load() {
      try {
        const u = await fetchUsageHistory(ns, explicit);
        if (!cancelled) setUsage(u);
      } catch {
        if (!cancelled) setUsage({ available: false, backend: null, items: [] });
      }
    }
    load();
    const id = setInterval(load, 120_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [namespaceFilter, clusterWide, choice, reloadKey]);

  const usingBackend = usage?.available === true;
  const noBackend = usage !== null && usage.available === false;

  const workloads = useMemo<WorkloadRightSizing[]>(() => {
    if (!usingBackend || !usage) return [];
    const byKind = resources as Record<string, Record<string, WorkloadObject>>;
    const rows = usage.items;
    return buildRightSizing(byKind, (ns, w, c) => windowStatsFromUsage(rows, ns, w, c));
  }, [resources, usage, usingBackend]);

  function setChoice(c: BackendChoice) {
    setChoiceState(c);
    saveBackendChoice(CHOICE_CONTEXT, c);
  }

  return {
    workloads,
    usage,
    detecting: usage === null,
    usingBackend,
    noBackend,
    backends,
    choice,
    setChoice,
    reload: () => setReloadKey((k) => k + 1),
  };
}
