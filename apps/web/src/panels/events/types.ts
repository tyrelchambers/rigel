// K8sEvent type for the web Events panel. Mirrors the shared contract in
// `packages/k8s/src/index.ts`, the Swift `K8sEvent` in
// `Sources/Rigel/Cluster/KubeTypes.swift`, and the normative spec in
// `docs/parity/events.md`. Kept local to the web app so the panel does not
// depend on workspace-package linking for a type-only import.
//
// Events are read-only and ephemeral (~1h TTL in Kubernetes). The client keys
// them by `metadata.uid` in the store. All display-relevant fields are
// nullable because the watch stream may omit them.

export interface InvolvedObject {
  kind: string | null;
  name: string | null;
  namespace: string | null;
  uid: string | null;
}

export interface K8sEvent {
  metadata: {
    name: string;
    namespace?: string;
    uid: string;
    creationTimestamp?: string; // ISO 8601
  };
  type: string | null; // "Normal" | "Warning" | null
  reason: string | null;
  message: string | null;
  count: number | null;
  firstTimestamp: string | null; // ISO 8601
  lastTimestamp: string | null; // ISO 8601
  involvedObject: InvolvedObject | null;
}

/** Type filter pill state. Initial state is "Warning" (per Swift ViewModel). */
export type EventTypeFilter = "All" | "Warning" | "Normal";

/** One bucket in the 1-hour event timeline ribbon. */
export interface EventBucket {
  index: number;
  /** Bucket start time, epoch milliseconds. */
  start: number;
  warnings: number;
  normal: number;
}
