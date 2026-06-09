// Local types for the web Overview panel. The Overview dashboard aggregates
// several cluster-scoped resources read-only from the Zustand store. To avoid
// workspace-package linking for type-only imports (same pattern as the other
// panels), the cross-panel shapes are re-exported here from their owning panels
// and a small `NodeMetrics` type is added for the (optional) metrics-server
// feed. See docs/parity/overview.md for the normative spec.

export type { Node, NodeCondition } from "@/panels/nodes/types";
export type { Pod } from "@/panels/pods/types";
export type { Deployment } from "@/panels/deployments/types";
export type { Namespace } from "@/panels/namespaces/types";
export type { K8sEvent, EventBucket } from "@/panels/events/types";

/**
 * One node's usage sample from the metrics-server
 * (`/apis/metrics.k8s.io/v1beta1/nodes`). Usage quantities are Kubernetes
 * resource strings (cpu: "n"/"m"/cores, memory: binary-SI bytes). Keyed by node
 * name in the store. Optional: absent when metrics-server is not installed.
 */
export interface NodeMetrics {
  metadata: { name: string };
  usage: {
    cpu?: string; // e.g. "450m", "1500000000n", "2"
    memory?: string; // e.g. "8192Mi", "8589934592"
  };
}

/** Aggregated cluster CPU/memory totals (cores / bytes). */
export interface ResourceTotals {
  cpuUsed: number; // cores
  cpuAllocatable: number; // cores
  memUsed: number; // bytes
  memAllocatable: number; // bytes
  /** cpuUsed / cpuAllocatable, clamped to [0, 1]; 0 when allocatable is 0. */
  cpuFraction: number;
  /** memUsed / memAllocatable, clamped to [0, 1]; 0 when allocatable is 0. */
  memFraction: number;
}

/** Pod phase breakdown for the Pods summary card. */
export interface PhaseCounts {
  running: number; // "Running" + "Succeeded"
  pending: number; // "Pending"
  failed: number; // "Failed"
  other: number; // everything else (incl. missing phase)
}
