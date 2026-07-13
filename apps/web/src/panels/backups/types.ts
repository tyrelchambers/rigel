// Types for the web Backups panel. CNPG types are reused from the Databases
// panel; this file adds the raw VolumeSnapshot shape and the normalized models
// the Backups panel renders. See HELM-87.
import type {
  CNPGCluster,
  DatabaseMeta,
  WalArchivingStatus,
} from "@/panels/databases/types";
import type { KindAccess } from "@/store/cluster";

// --- Raw CSI VolumeSnapshot (volumesnapshots.snapshot.storage.k8s.io) -------

export interface VolumeSnapshot {
  metadata: DatabaseMeta & {
    ownerReferences?: Array<{ kind?: string; name?: string; uid?: string }>;
  };
  spec?: {
    source?: {
      persistentVolumeClaimName?: string;
      volumeSnapshotContentName?: string;
    };
    volumeSnapshotClassName?: string;
  };
  status?: {
    readyToUse?: boolean;
    creationTime?: string; // RFC3339
    restoreSize?: string; // e.g. "8Gi"
    boundVolumeSnapshotContentName?: string;
  };
}

// --- Normalized models ------------------------------------------------------

export type BackupEventStatus =
  | "completed"
  | "failed"
  | "running"
  | "ready"
  | "notReady"
  | "other";

export type BackupMethod = "objectStore" | "volumeSnapshot" | "plugin" | "unknown";

/** A VolumeSnapshot a CNPG Backup run produced, nested under that run. */
export interface SnapshotChild {
  name: string;
  ready: boolean;
}

/** One CNPG Backup run. */
export interface BackupRow {
  id: string;
  kind: "cnpgBackup";
  name: string;
  namespace: string;
  cluster: string;
  method: BackupMethod;
  phase: string; // raw CNPG phase
  status: BackupEventStatus;
  finishedAt?: string; // status.stoppedAt ?? creationTimestamp
  startedAt?: string;
  durationSec?: number;
  beginWal?: string;
  endWal?: string;
  snapshots: SnapshotChild[];
}

/** One standalone CSI VolumeSnapshot. */
export interface SnapshotRow {
  id: string;
  kind: "volumeSnapshot";
  name: string;
  namespace: string;
  ready: boolean;
  status: BackupEventStatus; // "ready" | "notReady"
  sourcePvc?: string;
  snapshotClass?: string;
  restoreSize?: string;
  createdAt?: string; // status.creationTime ?? creationTimestamp
}

export type BackupEvent = BackupRow | SnapshotRow;

/** A database group (one CNPG cluster) or the catch-all "Other snapshots". */
export interface BackupGroup {
  key: string;
  title: string; // cluster name, or "Other snapshots"
  namespace?: string;
  kind: "cnpg" | "other";
  engine?: string; // "postgres" for CNPG groups
  lastBackup?: string; // RFC3339
  schedule?: string; // cron
  wal?: WalArchivingStatus;
  cluster?: CNPGCluster; // present for CNPG groups with a loaded Cluster (Backup-now target)
  events: BackupEvent[]; // newest first
}

/** What the panel body should render. */
export type BackupsView =
  | { kind: "loading" }
  | { kind: "forbidden"; forbiddenKinds: string[] }
  | { kind: "empty" }
  | { kind: "list"; groups: BackupGroup[] };

export type { KindAccess };
