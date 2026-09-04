export type FailoverProvider = "digitalocean";

export const DEFAULT_FAILOVER_REGION = "tor1";
export const DEFAULT_FAILOVER_NODE_SIZE = "s-4vcpu-8gb";
export const DEFAULT_FAILOVER_NODE_COUNT = 2;

export type FailoverSelection =
  | { kind: "app"; name: string; namespace: string }
  | { kind: "namespace"; namespace: string }
  | { kind: "workloads"; items: Array<{ kind: string; namespace: string; name: string }> };

/** What sits in front of the cluster and has to be repointed at the copy. */
export interface FailoverEdge {
  /** Host to SSH to, e.g. an haproxy VPS. */
  host: string;
  /** The server lines to replace, by name. */
  backends: Array<{ name: string; ip: string }>;
}

export type ObjectStoreAddressing = "virtualHost" | "path";

/** Any S3-compatible store: Spaces, Garage, MinIO, AWS. */
export interface FailoverObjectStore {
  endpoint: string;
  /** The SigV4 signing region the endpoint expects. */
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  /** `bucket.host` for AWS and Spaces, `host/bucket` for Garage and MinIO. */
  addressing: ObjectStoreAddressing;
}

export interface FailoverDestination {
  provider: FailoverProvider;
  token: string;
  region: string;
  nodeSize: string;
  nodeCount: number;
  objectStore?: FailoverObjectStore;
  edge?: FailoverEdge;
  lastSelection?: FailoverSelection;
}

/** What the Settings panel is allowed to see. Secret values never appear. */
export interface FailoverDestinationView {
  configured: boolean;
  provider: FailoverProvider;
  tokenSet: boolean;
  region: string;
  nodeSize: string;
  nodeCount: number;
  objectStore?: FailoverObjectStoreView;
  edge?: FailoverEdge;
  lastSelection?: FailoverSelection;
}

/** What Settings is allowed to see of a store. Key values never appear. */
export interface FailoverObjectStoreView {
  endpoint: string;
  region: string;
  bucket: string;
  addressing: ObjectStoreAddressing;
  accessKeySet: boolean;
  secretKeySet: boolean;
}

export interface FailoverDestinationPatch {
  token?: string;
  /** null removes the store; omitted secrets keep the stored ones. */
  objectStore?: Partial<FailoverObjectStore> | null;
  region?: string;
  nodeSize?: string;
  nodeCount?: number;
  edge?: FailoverEdge;
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
  | "secretPointsAtUnrestoredDatabase"
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

export interface DataCopyStep {
  kind: DataPlanKind;
  subject: DataPlan["subject"];
  action: "copied" | "skipped";
  /** Basenames only. Dump bytes never go in this object. */
  artifacts: string[];
  warning?: string;
}

export interface DataCopyResult {
  steps: DataCopyStep[];
}

export type FailoverStepStatus = "pending" | "running" | "done" | "failed" | "skipped";

/** One line of the Running screen. `id` is stable so a step can be updated. */
export interface FailoverStep {
  id: string;
  label: string;
  detail?: string;
  status: FailoverStepStatus;
  error?: string;
}

export type FailoverReporter = (step: FailoverStep) => void;

export interface FailoverJob {
  id: string;
  context: string | null;
  startedAt: string;
  endedAt?: string;
  status: "running" | "done" | "failed";
  steps: FailoverStep[];
  error?: string;
  /** Present once status is done. Dump bytes never appear here. */
  result?: unknown;
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
    dataPlans?: DataPlan[];
  };
  failoverCopyOf?: {
    context: string;
    batchId: string;
  };
  /** A destination that outlived its restore. It is still billing. */
  leftBehind?: {
    clusterId: string;
    context: string;
    at: string;
    error: string;
  };
}
