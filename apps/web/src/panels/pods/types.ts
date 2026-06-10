// Pod type for the web Pods panel. Mirrors the shared contract in
// `packages/k8s/src/index.ts` and the Swift `Pod` in
// `Sources/Helmsman/Cluster/KubeTypes.swift`. Kept local to the web app so the
// panel does not depend on workspace-package linking for a type-only import.

export interface ContainerStatus {
  name: string;
  ready: boolean;
  restartCount: number;
  state?: {
    running?: { startedAt?: string };
    waiting?: { reason?: string; message?: string };
    terminated?: { reason?: string; exitCode?: number };
  };
}

export interface Pod {
  metadata: {
    name: string;
    namespace?: string;
    uid: string;
    creationTimestamp?: string; // ISO 8601
    labels?: Record<string, string>;
  };
  spec: {
    nodeName?: string;
    containers: Array<{
      name: string;
      image?: string;
      ports?: Array<{ containerPort: number; name?: string }>;
    }>;
  };
  status?: {
    phase?: string; // "Running" | "Pending" | "Failed" | "Succeeded" | ...
    podIP?: string;
    containerStatuses?: ContainerStatus[];
  };
}
