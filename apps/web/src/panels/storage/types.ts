// Types for the web Storage panel. Mirrors the Swift `StorageTypes.swift` and
// the normative spec in `docs/parity/storage.md`.
//
// PersistentVolumeClaims are namespace-scoped; PersistentVolumes and
// StorageClasses are cluster-scoped.

export interface ObjectMeta {
  name: string;
  namespace?: string;
  uid?: string;
  creationTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface PersistentVolumeClaim {
  metadata: ObjectMeta;
  spec?: {
    accessModes?: string[];
    resources?: { requests?: Record<string, string> };
    storageClassName?: string;
    volumeName?: string;
  };
  status?: {
    phase?: string;
    capacity?: Record<string, string>;
    accessModes?: string[];
  };
}

export interface PersistentVolume {
  metadata: ObjectMeta;
  spec?: {
    capacity?: Record<string, string>;
    accessModes?: string[];
    persistentVolumeReclaimPolicy?: string;
    storageClassName?: string;
    claimRef?: { namespace?: string; name?: string };
  };
  status?: { phase?: string };
}

export interface StorageClass {
  metadata: ObjectMeta;
  provisioner?: string;
  reclaimPolicy?: string;
  volumeBindingMode?: string;
  allowVolumeExpansion?: boolean;
}

/** Active kind toggle for the Storage panel. */
export type StorageKind = "pvcs" | "pvs" | "storageclasses";
