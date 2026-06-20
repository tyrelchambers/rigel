// Node type for the web Nodes panel. Mirrors the Swift `Node` in
// `Sources/Rigel/Cluster/KubeTypes.swift` and the normative spec in
// `docs/parity/nodes.md`. Nodes are cluster-scoped (no namespace).

export interface NodeCondition {
  type: string; // "Ready" | "MemoryPressure" | "DiskPressure" | "PIDPressure" | "NetworkUnavailable" | ...
  status: string; // "True" | "False" | "Unknown"
  reason?: string;
  message?: string;
}

export interface NodeAddress {
  type: string; // "InternalIP" | "Hostname" | "ExternalIP" | ...
  address: string;
}

export interface NodeInfo {
  osImage?: string;
  kernelVersion?: string;
  containerRuntimeVersion?: string;
  kubeletVersion?: string;
  architecture?: string;
  operatingSystem?: string;
}

export interface NodeTaint {
  key: string;
  value?: string;
  effect: string; // "NoSchedule" | "NoExecute" | "PreferNoSchedule"
}

export interface NodeSpec {
  unschedulable?: boolean;
  podCIDR?: string;
  taints?: NodeTaint[];
}

export interface NodeStatus {
  conditions?: NodeCondition[];
  addresses?: NodeAddress[];
  nodeInfo?: NodeInfo;
  // Quantity strings keyed by resource name: "cpu", "memory", "ephemeral-storage", "pods".
  capacity?: Record<string, string>;
  allocatable?: Record<string, string>;
}

export interface Node {
  metadata: {
    name: string;
    uid?: string;
    creationTimestamp?: string; // ISO 8601
    labels?: Record<string, string>;
  };
  spec?: NodeSpec;
  status?: NodeStatus;
}
