import type {
  Deployment,
  Node,
  NodeMetrics,
  PhaseCounts,
  Pod,
  ResourceTotals,
} from "./types";

/**
 * Pure aggregation helpers for the Overview dashboard. Mirrors the Swift
 * `OverviewPanel` derivations and `Viz` aggregations in
 * `Sources/Rigel/Charts/Aggregations.swift`. See docs/parity/overview.md.
 *
 * Everything here is pure and unit-tested (overviewDisplay.test.ts). The panel
 * computes all summary cards from these functions over live store snapshots.
 */

// ---------------------------------------------------------------------------
// Pod phase breakdown
// ---------------------------------------------------------------------------

/**
 * Count pods by phase. "Running" and "Succeeded" both count as `running`;
 * "Pending" goes to `pending`; "Failed" goes to `failed`; everything else
 * (including a missing phase) goes to `other`. Mirrors the Swift phase tally on
 * the Pods card.
 */
export function phaseCounts(pods: Pod[]): PhaseCounts {
  const result: PhaseCounts = { running: 0, pending: 0, failed: 0, other: 0 };
  for (const p of pods) {
    switch (p.status?.phase) {
      case "Running":
      case "Succeeded":
        result.running++;
        break;
      case "Pending":
        result.pending++;
        break;
      case "Failed":
        result.failed++;
        break;
      default:
        result.other++;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Deployment health
// ---------------------------------------------------------------------------

/**
 * A deployment is healthy when it has no desired replicas (`desired === 0`) or
 * at least as many ready as desired. `desired = spec.replicas ?? status.replicas
 * ?? 0`; `ready = status.readyReplicas ?? 0`. Mirrors the Swift health rule.
 */
export function deploymentHealth(d: Deployment): boolean {
  const ready = d.status?.readyReplicas ?? 0;
  const desired = d.spec?.replicas ?? d.status?.replicas ?? 0;
  return desired === 0 || ready >= desired;
}

/** Count of deployments that are NOT healthy (`desired > 0 && ready < desired`). */
export function unhealthyDeploymentCount(deployments: Deployment[]): number {
  return deployments.filter((d) => !deploymentHealth(d)).length;
}

// ---------------------------------------------------------------------------
// Node ready / pressure
// ---------------------------------------------------------------------------

/**
 * `{ ready, total }` where `ready` counts nodes whose `Ready` condition has
 * `status === "True"`. A node with no `Ready` condition is not ready.
 */
export function nodeReadyCount(nodes: Node[]): { ready: number; total: number } {
  const total = nodes.length;
  const ready = nodes.filter((n) => {
    const cond = n.status?.conditions?.find((c) => c.type === "Ready");
    return cond?.status === "True";
  }).length;
  return { ready, total };
}

/**
 * Sum, across all nodes, of active pressure conditions: any condition with
 * `type !== "Ready"` and `status === "True"` (DiskPressure, MemoryPressure,
 * PIDPressure, NetworkUnavailable, and so on).
 */
export function nodePressureCount(nodes: Node[]): number {
  let count = 0;
  for (const n of nodes) {
    count += (n.status?.conditions ?? []).filter(
      (c) => c.type !== "Ready" && c.status === "True",
    ).length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Quantity parsing
// ---------------------------------------------------------------------------

const BINARY_SUFFIX: Record<string, number> = {
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
  Pi: 2 ** 50,
  Ei: 2 ** 60,
};

// Decimal-SI suffixes for CPU (and decimal memory if ever encountered).
const DECIMAL_SUFFIX: Record<string, number> = {
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  "": 1,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
};

/**
 * Parse a Kubernetes CPU quantity into cores. Accepts nanocores ("450000000n"),
 * millicores ("450m"), or plain cores ("2", "1.5"). Returns 0 for missing or
 * unparseable input.
 */
export function parseCpuQuantity(quantity: string | undefined): number {
  if (!quantity) return 0;
  const m = /^(\d+(?:\.\d+)?)([numkMGTP]?)$/.exec(quantity.trim());
  if (!m) return 0;
  const value = Number(m[1]);
  if (Number.isNaN(value)) return 0;
  const factor = DECIMAL_SUFFIX[m[2]];
  return factor === undefined ? 0 : value * factor;
}

/**
 * Parse a Kubernetes memory quantity into bytes. Accepts binary-SI ("8192Mi"),
 * decimal-SI ("8G"), or plain bytes ("8589934592"). Returns 0 for missing or
 * unparseable input.
 */
export function parseMemQuantity(quantity: string | undefined): number {
  if (!quantity) return 0;
  const m = /^(\d+(?:\.\d+)?)([A-Za-z]*)$/.exec(quantity.trim());
  if (!m) return 0;
  const value = Number(m[1]);
  if (Number.isNaN(value)) return 0;
  const suffix = m[2];
  if (!suffix) return value;
  if (suffix in BINARY_SUFFIX) return value * BINARY_SUFFIX[suffix];
  if (suffix in DECIMAL_SUFFIX) return value * DECIMAL_SUFFIX[suffix];
  return 0;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format CPU cores for display: "0" when 0, "{cores*1000}m" when below 1 core,
 * else "{cores.toFixed(1)}". Mirrors the Swift `formatCpu`.
 */
export function formatCpu(cores: number): string {
  if (cores === 0) return "0";
  if (cores < 1) return `${(cores * 1000).toFixed(0)}m`;
  return cores.toFixed(1);
}

/**
 * Format a Kubernetes binary-SI quantity (e.g. "8192Mi") or raw byte count into
 * the largest clean binary unit ("8Gi", "512Mi"). Returns "—" for missing or
 * unparseable input. Mirrors the Nodes panel `formatBytes`.
 */
export function formatBytes(quantity: string | undefined): string {
  if (!quantity) return "—";
  const m = /^(\d+(?:\.\d+)?)([A-Za-z]+)?$/.exec(quantity.trim());
  if (!m) return "—";
  const value = Number(m[1]);
  if (Number.isNaN(value)) return "—";
  const suffix = m[2];
  let bytes: number;
  if (!suffix) {
    bytes = value;
  } else if (suffix in BINARY_SUFFIX) {
    bytes = value * BINARY_SUFFIX[suffix];
  } else {
    return "—";
  }
  const units = ["Ei", "Pi", "Ti", "Gi", "Mi", "Ki"] as const;
  for (const u of units) {
    const factor = BINARY_SUFFIX[u];
    if (bytes >= factor) {
      const n = bytes / factor;
      const rounded = Number.isInteger(n) ? n : Math.round(n * 10) / 10;
      return `${rounded}${u}`;
    }
  }
  return `${bytes}`;
}

// ---------------------------------------------------------------------------
// Cluster resource totals
// ---------------------------------------------------------------------------

/**
 * Aggregate CPU/memory capacity, allocatable, and usage across nodes. Allocatable
 * falls back to capacity per resource. Usage comes from `nodeMetrics` keyed by
 * node name (absent maps to 0). `cpuFraction`/`memFraction` are eagerly computed
 * and clamped to [0, 1] (0 when the corresponding allocatable is 0). Mirrors
 * `Viz.clusterResourceTotals`.
 */
export function clusterResourceTotals(
  nodes: Node[],
  nodeMetrics: Record<string, NodeMetrics>,
): ResourceTotals {
  let cpuUsed = 0;
  let cpuAllocatable = 0;
  let memUsed = 0;
  let memAllocatable = 0;

  for (const node of nodes) {
    const cap = node.status?.capacity ?? {};
    const alloc = node.status?.allocatable ?? {};

    cpuAllocatable += parseCpuQuantity(alloc.cpu ?? cap.cpu);
    memAllocatable += parseMemQuantity(alloc.memory ?? cap.memory);

    const m = nodeMetrics[node.metadata.name];
    if (m) {
      cpuUsed += parseCpuQuantity(m.usage.cpu);
      memUsed += parseMemQuantity(m.usage.memory);
    }
  }

  return {
    cpuUsed,
    cpuAllocatable,
    memUsed,
    memAllocatable,
    cpuFraction: cpuAllocatable > 0 ? Math.min(cpuUsed / cpuAllocatable, 1) : 0,
    memFraction: memAllocatable > 0 ? Math.min(memUsed / memAllocatable, 1) : 0,
  };
}

/** Per-node CPU/memory utilization (one entry per node, allocatable + usage). */
export interface NodeResourceTotals {
  name: string;
  cpuUsed: number;
  cpuAllocatable: number;
  cpuFraction: number;
  memUsed: number;
  memAllocatable: number;
  memFraction: number;
}

/**
 * Break the cluster totals down per node — one {used, allocatable, fraction}
 * row per node for CPU and memory, sorted by node name for stable display.
 * Same parsing/clamping rules as `clusterResourceTotals`; a node without a usage
 * sample reports 0 used (fraction 0) but still contributes its allocatable.
 */
export function perNodeResourceTotals(
  nodes: Node[],
  nodeMetrics: Record<string, NodeMetrics>,
): NodeResourceTotals[] {
  return nodes
    .map((node) => {
      const cap = node.status?.capacity ?? {};
      const alloc = node.status?.allocatable ?? {};
      const cpuAllocatable = parseCpuQuantity(alloc.cpu ?? cap.cpu);
      const memAllocatable = parseMemQuantity(alloc.memory ?? cap.memory);
      const m = nodeMetrics[node.metadata.name];
      const cpuUsed = m ? parseCpuQuantity(m.usage.cpu) : 0;
      const memUsed = m ? parseMemQuantity(m.usage.memory) : 0;
      return {
        name: node.metadata.name,
        cpuUsed,
        cpuAllocatable,
        cpuFraction: cpuAllocatable > 0 ? Math.min(cpuUsed / cpuAllocatable, 1) : 0,
        memUsed,
        memAllocatable,
        memFraction: memAllocatable > 0 ? Math.min(memUsed / memAllocatable, 1) : 0,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Metrics are "available" when at least one node has a usage sample. Used to
 * decide between the gauges row and the metrics-server fallback card.
 */
export function metricsAvailable(nodeMetrics: Record<string, NodeMetrics>): boolean {
  return Object.keys(nodeMetrics).length > 0;
}
