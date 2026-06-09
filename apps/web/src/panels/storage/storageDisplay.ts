import type { PersistentVolumeClaim, PersistentVolume, StorageClass } from "./types";

/**
 * Pure display helpers for the Storage panel. Mirrors the Swift
 * `StorageViewModel` derivations and the normative spec in
 * `docs/parity/storage.md`.
 */

const ACCESS_MODE_ABBREVIATIONS: Record<string, string> = {
  ReadWriteOnce: "RWO",
  ReadOnlyMany: "ROX",
  ReadWriteMany: "RWX",
  ReadWriteOncePod: "RWOP",
};

/**
 * Convert Kubernetes access mode strings to conventional abbreviations.
 * Unknown modes pass through unchanged. Always applied even for a single mode.
 */
export function abbreviateAccessModes(modes: string[]): string[] {
  return modes.map((m) => ACCESS_MODE_ABBREVIATIONS[m] ?? m);
}

// Concrete Tailwind palette matching the web stack convention (mirrors
// `podDisplay.phaseColorClass`): green = healthy, yellow = pending, red =
// failed, muted gray = unknown. The Swift spec's `running`/`pending`/`failed`
// semantic names map onto these.
const PHASE_GREEN = "bg-green-500/15 text-green-600 dark:text-green-400";
const PHASE_AMBER = "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400";
const PHASE_RED = "bg-red-500/15 text-red-600 dark:text-red-400";
const PHASE_GRAY = "bg-muted text-muted-foreground";

const PHASE_COLOR_MAP: Record<string, string> = {
  Bound: PHASE_GREEN,
  Available: PHASE_GREEN,
  Pending: PHASE_AMBER,
  Lost: PHASE_RED,
  Failed: PHASE_RED,
};

/**
 * Map a storage phase string to Tailwind color classes. Unknown phases fall
 * through to the tertiary gray (muted) default.
 */
export function storagePhaseColor(phase: string): string {
  return PHASE_COLOR_MAP[phase] ?? PHASE_GRAY;
}

/** True when the StorageClass carries the cluster-default annotation. */
export function isDefaultStorageClass(sc: StorageClass): boolean {
  return (
    sc.metadata.annotations?.["storageclass.kubernetes.io/is-default-class"] ===
    "true"
  );
}

/**
 * Format a PV's claim reference as `<namespace>/<name>`. Namespace defaults to
 * "default" when missing. Returns null when there is no claimRef (PV unbound).
 */
export function claimRef(pv: PersistentVolume): string | null {
  const ref = pv.spec?.claimRef;
  if (!ref?.name) return null;
  return `${ref.namespace ?? "default"}/${ref.name}`;
}

/**
 * Case-insensitive substring match. Joins the (defined) search fields into one
 * haystack and tests for the trimmed, lowercased query. Empty query matches all.
 */
export function matchesSearch(
  searchFields: (string | undefined | null)[],
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const haystack = searchFields
    .filter((f): f is string => f !== undefined && f !== null)
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

// ---------------------------------------------------------------------------
// Per-kind field extraction (shared by display + search) and sorting.
// ---------------------------------------------------------------------------

/** PVC phase, defaulting to "Unknown". */
export function pvcPhase(pvc: PersistentVolumeClaim): string {
  return pvc.status?.phase ?? "Unknown";
}

/** PVC access modes, preferring status over spec. */
export function pvcAccessModes(pvc: PersistentVolumeClaim): string[] {
  return pvc.status?.accessModes ?? pvc.spec?.accessModes ?? [];
}

/**
 * PVC capacity: actual provisioned (status.capacity.storage) first, then the
 * requested amount (spec.resources.requests.storage), then "—". Displayed as-is.
 */
export function pvcCapacity(pvc: PersistentVolumeClaim): string {
  return (
    pvc.status?.capacity?.["storage"] ??
    pvc.spec?.resources?.requests?.["storage"] ??
    "—"
  );
}

/** PV phase, defaulting to "Unknown". */
export function pvPhase(pv: PersistentVolume): string {
  return pv.status?.phase ?? "Unknown";
}

/** PV capacity (spec.capacity.storage) or "—". Displayed as-is. */
export function pvCapacity(pv: PersistentVolume): string {
  return pv.spec?.capacity?.["storage"] ?? "—";
}

export function matchesPVC(pvc: PersistentVolumeClaim, query: string): boolean {
  return matchesSearch(
    [
      pvc.metadata.name,
      pvc.metadata.namespace,
      pvc.spec?.storageClassName,
      pvc.spec?.volumeName,
      pvcPhase(pvc),
    ],
    query,
  );
}

export function matchesPV(pv: PersistentVolume, query: string): boolean {
  return matchesSearch(
    [
      pv.metadata.name,
      pv.spec?.storageClassName,
      claimRef(pv),
      pvPhase(pv),
      pv.spec?.persistentVolumeReclaimPolicy,
    ],
    query,
  );
}

export function matchesStorageClass(sc: StorageClass, query: string): boolean {
  return matchesSearch(
    [sc.metadata.name, sc.provisioner, sc.reclaimPolicy, sc.volumeBindingMode],
    query,
  );
}

/** PVCs sort by namespace (alphabetic) then name (lexicographic). */
export function sortPVCs(
  pvcs: PersistentVolumeClaim[],
): PersistentVolumeClaim[] {
  return [...pvcs].sort((a, b) => {
    const ns = (a.metadata.namespace ?? "").localeCompare(
      b.metadata.namespace ?? "",
    );
    if (ns !== 0) return ns;
    return a.metadata.name.localeCompare(b.metadata.name);
  });
}

/** PVs sort by name only. */
export function sortPVs(pvs: PersistentVolume[]): PersistentVolume[] {
  return [...pvs].sort((a, b) =>
    a.metadata.name.localeCompare(b.metadata.name),
  );
}

/** StorageClasses sort by name only. */
export function sortStorageClasses(scs: StorageClass[]): StorageClass[] {
  return [...scs].sort((a, b) =>
    a.metadata.name.localeCompare(b.metadata.name),
  );
}
