// kubectl wrappers, output parsing, and resource types are ported here
// from Sources/Helmsman/Cluster/ via the parity orchestrator.

export {
  type SuggestedAction,
  ACTION_KINDS,
  extractActionBlocks,
  stripActionBlocks,
  parseSuggestedActions,
} from "./actionBlocks";

/** Kubernetes ObjectMeta (subset used by the web panels). */
export interface ObjectMeta {
  name: string;
  namespace?: string;
  uid: string;
  creationTimestamp?: string; // ISO 8601
  labels?: Record<string, string>;
}

/** Container state (subset). */
export interface ContainerState {
  running?: { startedAt?: string };
  waiting?: { reason?: string; message?: string };
  terminated?: { reason?: string; exitCode?: number };
}

/** A single entry in `status.containerStatuses`. */
export interface ContainerStatus {
  name: string;
  ready: boolean;
  restartCount: number;
  state?: ContainerState;
}

/** A container in `spec.containers`. */
export interface Container {
  name: string;
  image?: string;
  ports?: Array<{ containerPort: number; name?: string }>;
}

/**
 * Pod — mirrors the Kubernetes Pod JSON schema and the Swift
 * `Pod` type in `Sources/Helmsman/Cluster/KubeTypes.swift`.
 */
export interface Pod {
  metadata: ObjectMeta;
  spec: {
    nodeName?: string;
    containers: Container[];
  };
  status?: {
    phase?: string; // "Running" | "Pending" | "Failed" | "Succeeded" | ...
    podIP?: string;
    containerStatuses?: ContainerStatus[];
  };
}

/** The resource an event refers to (`involvedObject`). All fields optional. */
export interface InvolvedObject {
  kind: string | null;
  name: string | null;
  namespace: string | null;
  uid: string | null;
}

/**
 * K8sEvent — mirrors the Kubernetes Event JSON schema and the Swift
 * `K8sEvent` type in `Sources/Helmsman/Cluster/KubeTypes.swift`. Events are
 * read-only and ephemeral (~1h TTL). See `docs/parity/events.md`.
 *
 * NOTE: `metadata` here is loosened (`type` and timestamps may be absent on the
 * watch stream), so it does not reuse `ObjectMeta` (which requires `uid`). The
 * client keys events by `metadata.uid`.
 */
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
