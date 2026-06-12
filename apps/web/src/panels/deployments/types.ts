// Deployment types for the web Deployments panel. Mirrors the shared contract
// in `packages/k8s` and the Swift `Deployment` / `DeploymentSpec` /
// `DeploymentStatus` structs in `Sources/Helmsman/Cluster/KubeTypes.swift`.
// Kept local to the web app so the panel does not depend on workspace-package
// linking for a type-only import (same pattern as pods/types.ts).

export interface EnvVar {
  name: string;
  value?: string;
  /** Present for secret/configMap/field refs. When set, the value is not a plain string. */
  valueFrom?: unknown;
}

export interface Container {
  name: string;
  image?: string;
  ports?: Array<{ containerPort: number; name?: string }>;
  env?: EnvVar[];
  resources?: {
    requests?: Record<string, string>;
    limits?: Record<string, string>;
  };
}

export interface PodTemplate {
  metadata?: {
    labels?: Record<string, string>;
  };
  spec?: { containers: Container[] };
}

export interface DeploymentSpec {
  replicas?: number;
  selector?: { matchLabels?: Record<string, string> };
  template?: PodTemplate;
  strategy?: {
    type?: string;
    rollingUpdate?: {
      maxSurge?: string | number;
      maxUnavailable?: string | number;
    };
  };
  paused?: boolean;
}

export interface DeploymentStatus {
  replicas?: number;
  readyReplicas?: number;
  availableReplicas?: number;
  updatedReplicas?: number;
}

export interface Deployment {
  metadata: {
    name: string;
    namespace?: string;
    uid?: string;
    creationTimestamp?: string; // ISO 8601
    labels?: Record<string, string>;
  };
  spec?: DeploymentSpec;
  status?: DeploymentStatus;
}

/** Summary of a single container for the expanded SPEC block. */
export interface ContainerSummary {
  name: string;
  image: string;
  ports: number[];
  cpuReq?: string;
  cpuLim?: string;
  memReq?: string;
  memLim?: string;
}
