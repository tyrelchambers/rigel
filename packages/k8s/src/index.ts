// kubectl wrappers, output parsing, and resource types are ported here
// from Sources/Helmsman/Cluster/ via the parity orchestrator.

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
