// Glue layer: turn live workload specs (Zustand store) + backend usage history
// into per-container WindowStats and WorkloadRightSizing rows. Pure functions —
// no I/O. Usage comes from a Prometheus/VictoriaMetrics backend via the server
// (see windowStatsFromUsage); there is no in-browser sampler.

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
import {
  podBelongsTo,
  windowStatsFromUsage,
  type UsageRow,
} from "@rigel/k8s/src/usage";

// Moved to @rigel/k8s (shared with the server's Prometheus route and the audit
// CLI's performance audit); re-exported here so existing right-sizing imports
// keep working unchanged.
export { podBelongsTo, windowStatsFromUsage, type UsageRow };

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

// podBelongsTo, UsageRow, and windowStatsFromUsage moved to @rigel/k8s/src/usage
// (see the re-export above) so the CLI and server share the same implementation.

const KIND_MAP: Record<string, WorkloadKind> = {
  deployments: "deployment",
  statefulsets: "statefulset",
  daemonsets: "daemonset",
};

/** Resolves historical usage stats for a (namespace, workload, container). */
export type WindowStatsProvider = (
  namespace: string,
  workload: string,
  container: string,
) => WindowStats;

/**
 * Build WorkloadRightSizing rows from store workloads, reading usage stats from
 * `statsFor` (windowStatsFromUsage, backed by the Prometheus/VictoriaMetrics
 * backend).
 *
 * @param byKind  store resource maps keyed by watch-kind
 *                ("deployments"|"statefulsets"|"daemonsets")
 */
export function buildRightSizing(
  byKind: Record<string, Record<string, WorkloadObject>>,
  statsFor: WindowStatsProvider,
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
        analyzeContainer(containerResources(c), statsFor(ns, name, c.name)),
      );
      out.push(summarizeWorkload(kind, name, ns, results));
    }
  }
  return out;
}
