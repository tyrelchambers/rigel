export type FailoverProvider = "digitalocean";

export const DEFAULT_FAILOVER_REGION = "tor1";
export const DEFAULT_FAILOVER_NODE_SIZE = "s-4vcpu-8gb";
export const DEFAULT_FAILOVER_NODE_COUNT = 2;

export type FailoverSelection =
  | { kind: "app"; name: string; namespace: string }
  | { kind: "namespace"; namespace: string }
  | { kind: "workloads"; items: Array<{ kind: string; namespace: string; name: string }> };

export interface FailoverDestination {
  provider: FailoverProvider;
  token: string;
  spacesKey: string;
  spacesSecret: string;
  region: string;
  nodeSize: string;
  nodeCount: number;
  lastSelection?: FailoverSelection;
}

/** What the Settings panel is allowed to see. Secret values never appear. */
export interface FailoverDestinationView {
  configured: boolean;
  provider: FailoverProvider;
  tokenSet: boolean;
  spacesKeySet: boolean;
  spacesSecretSet: boolean;
  region: string;
  nodeSize: string;
  nodeCount: number;
  lastSelection?: FailoverSelection;
}

export interface FailoverDestinationPatch {
  token?: string;
  spacesKey?: string;
  spacesSecret?: string;
  region?: string;
  nodeSize?: string;
  nodeCount?: number;
}

export type DataPlanKind = "cnpgBarman" | "pgDump" | "pvcTar" | "startEmpty";

export interface DataPlan {
  subject: { kind: string; namespace: string; name: string };
  kind: DataPlanKind;
  bytes?: number;
  warning?: string;
}

export type PortabilityRuleId =
  | "storageClassMissing"
  | "nfsBackedVolume"
  | "hostPathVolume"
  | "nodeSelectorUnsatisfiable"
  | "ingressClassMissing"
  | "ingressControllerAnnotationsWillBeIgnored"
  | "middlewareCrdMissing"
  | "loadBalancerServiceIsLocalOnly"
  | "tailnetAddressInSpec"
  | "imagePullSecretMissing"
  | "mutableImageTag"
  | "tlsSecretWithoutCertificate"
  | "dns01SolverSecretOutOfClosure"
  | "crossNamespaceDependency"
  | "sharedInfraDependency"
  | "statefulDataPlanMissing"
  | "backupTargetIsInsideSourceCluster";

export type PortabilitySeverity = "blocker" | "rewrite" | "warning";

export interface PortabilityFinding {
  rule: PortabilityRuleId;
  severity: PortabilitySeverity;
  subject: { kind: string; namespace: string; name: string };
  whatsWrong: string;
  rewrite?: { label: string; from: unknown; to: unknown };
}

export interface TargetProfile {
  storageClasses: string[];
  defaultStorageClass?: string;
  ingressClasses: string[];
  loadBalancerKind: "LoadBalancer" | "NodePort";
  hasCertManager: boolean;
  hasCnpg: boolean;
  hasTraefikCrds: boolean;
  nodeCount: number;
}

export interface FailoverWorkload {
  kind: string;
  namespace: string;
  name: string;
  replicas: number;
}

export interface FailoverState {
  failedOverTo?: {
    context: string;
    clusterId?: string;
    at: string;
    batchId: string;
    lbAddress?: string;
    scaledToZero: FailoverWorkload[];
    edgeConfirmed: boolean;
  };
  failoverCopyOf?: {
    context: string;
    batchId: string;
  };
}
