// Types for the web Databases panel. Mirrors the Swift
// `Sources/Helmsman/Panels/Databases/` data models for CloudNativePG (CNPG)
// clusters and image-detected databases (Deployment / StatefulSet). Kept local
// to the web app so the panel does not depend on workspace-package linking for
// a type-only import (same pattern as workloads/types.ts and pods/types.ts).
//
// See docs/parity/databases.md for the normative spec.

/** Shared metadata sub-object. */
export interface DatabaseMeta {
  name: string;
  namespace?: string;
  uid?: string;
  creationTimestamp?: string; // ISO 8601
  labels?: Record<string, string>;
}

// --- Raw CNPG cluster CRD (clusters.postgresql.cnpg.io) --------------------

export interface CNPGClusterCondition {
  type?: string;
  status?: string; // "True" | "False" | "Unknown"
}

export interface CNPGClusterSpec {
  instances?: number;
  imageName?: string;
}

export interface CNPGClusterStatus {
  instances?: number;
  readyInstances?: number;
  phase?: string;
  currentPrimary?: string;
  lastSuccessfulBackup?: string; // RFC3339
  conditions?: CNPGClusterCondition[];
}

export interface CNPGCluster {
  metadata: DatabaseMeta;
  spec?: CNPGClusterSpec;
  status?: CNPGClusterStatus;
}

// --- Raw CNPG scheduled-backup CRD (scheduledbackups.postgresql.cnpg.io) ----

export interface CNPGScheduledBackup {
  metadata: DatabaseMeta;
  spec?: {
    schedule?: string;
    cluster?: { name?: string };
  };
}

// --- Raw CNPG backup CRD (backups.postgresql.cnpg.io) ----------------------
// The authoritative per-run record. CNPG does NOT update
// `cluster.status.lastSuccessfulBackup` for plugin-method (barman-cloud)
// backups, so the newest completed Backup object is the real "last backup".

export interface CNPGBackup {
  metadata: DatabaseMeta;
  spec?: {
    cluster?: { name?: string };
    method?: string;
  };
  status?: {
    phase?: string; // "completed" | "failed" | "running" | …
    stoppedAt?: string; // RFC3339 — when the backup finished
  };
}

// --- Raw Deployment / StatefulSet (image-detected) -------------------------

export interface WorkloadDB {
  metadata: DatabaseMeta;
  spec?: {
    replicas?: number;
    selector?: { matchLabels?: Record<string, string> };
    template?: {
      spec?: { containers?: Array<{ name?: string; image?: string }> };
    };
  };
  status?: {
    replicas?: number;
    readyReplicas?: number;
  };
}

// --- Raw Pod (label-matched children) --------------------------------------

export interface DatabasePodRaw {
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
  spec?: { nodeName?: string };
  status?: { phase?: string };
}

// --- Normalized panel models ------------------------------------------------

/** Where an instance was detected. */
export type DatabaseSource = "cnpg" | "deployment" | "statefulset";

/** Recognized database engine kinds (image-detected or CNPG-fixed). */
export type DatabaseKind =
  | "postgres"
  | "mysql"
  | "mariadb"
  | "mongo"
  | "redis"
  | "valkey"
  | "keydb"
  | "clickhouse"
  | "elasticsearch"
  | "opensearch"
  | "cassandra"
  | "scylla"
  | "dragonfly";

/** WAL archiving health (CNPG only). */
export type WalArchivingStatus = "healthy" | "failing" | "unknown";

// --- Raw Secret (credential discovery + username decode) -------------------
// Minimal shape needed by the Databases panel; the full Secret type lives in
// @rigel/k8s but this keeps the panel free of workspace-package linking for
// a type-only import (same rationale as the other models above).

export interface DatabaseSecret {
  metadata: { name: string; namespace?: string };
  data?: Record<string, string>; // base64-encoded values
}

// --- Capabilities / action bar ---------------------------------------------
// Mirrors the Swift `DatabaseAction`, `DatabaseActionItem`, `ConnectionInfo`,
// `BackupInfo`, and `DatabaseCapabilities`. See docs/parity/databases-controls.md.

/** One per-instance action. A discriminated union on `type`. */
export type DatabaseAction =
  | { type: "backupNow" }
  | { type: "switchover"; to: string } // target standby pod name
  | { type: "hibernate"; on: boolean } // on=true hibernate, on=false resume
  | { type: "scale"; current: number; desired: number }
  | { type: "portForward" }
  | { type: "revealCredentials" }
  | { type: "copyDSN" };

/** An action plus its enabled/disabled state for the action bar. */
export interface DatabaseActionItem {
  action: DatabaseAction;
  enabled: boolean;
  disabledReason?: string;
}

/** Connection target used by port-forward, credentials, and DSN. */
export interface ConnectionInfo {
  targetKind: "svc" | "pod"; // "svc" for CNPG, "pod" for deployment/statefulset
  targetName: string; // e.g. "my-cluster-rw", "my-postgres-0"
  namespace: string;
  port: number;
  scheme: string; // e.g. "postgresql", "mysql", "redis"
  secretName?: string; // e.g. "my-cluster-app" for CNPG
  username?: string; // decoded from secret (CNPG only)
  dbName?: string; // "app" for CNPG, undefined for image-detected
}

/** CNPG backup health summary (CNPG only). */
export interface BackupInfo {
  lastBackup?: string; // RFC3339 timestamp, undefined if none yet
  schedule?: string; // cron string from ScheduledBackup
  walArchivingHealthy?: boolean; // undefined if no ContinuousArchiving condition
}

/** Full capabilities for one instance: action bar + connection + backup info. */
export interface DatabaseCapabilities {
  actions: DatabaseActionItem[];
  backupInfo?: BackupInfo; // CNPG only
  connection?: ConnectionInfo;
}

/** A child pod matched to an instance by label selector. */
export interface DatabasePod {
  name: string;
  phase: string; // Running | Pending | Failed | Succeeded | Unknown
  node?: string;
  isPrimary: boolean;
}

/** A normalized database instance shown as one expandable card. */
export interface DatabaseInstance {
  id: string;
  name: string;
  namespace: string;
  kind: DatabaseKind;
  source: DatabaseSource;
  creationTimestamp?: string;
  image?: string;
  desiredReplicas: number;
  readyReplicas: number;
  phaseText: string;
  isHealthy: boolean;
  /** Labels used to match child pods. */
  labelSelector: Record<string, string>;
  /** CNPG primary pod name (cnpg only). */
  cnpgPrimary?: string;
  /** CNPG: status.lastSuccessfulBackup (RFC3339) or undefined. */
  lastBackup?: string;
  /** CNPG: cron string from a matching ScheduledBackup, or undefined. */
  scheduledBackup?: string;
  /** CNPG: WAL archiving condition status. */
  walArchiving?: WalArchivingStatus;
}
