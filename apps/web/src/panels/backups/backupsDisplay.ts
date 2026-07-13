import type { StatusBadgeVariant } from "@/panels/components/StatusBadge";
import type { BackupEventStatus, BackupMethod } from "./types";

/** Map a raw CNPG Backup phase to a normalized status. */
export function backupStatus(phase: string | undefined): BackupEventStatus {
  switch ((phase ?? "").toLowerCase()) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "running":
    case "started":
    case "pending":
    case "walarchivingpending":
      return "running";
    default:
      return "other";
  }
}

/** Map a CNPG Backup `spec.method` value to a normalized method. */
export function backupMethod(method: string | undefined): BackupMethod {
  switch (method) {
    case "barmanObjectStore":
      return "objectStore";
    case "volumeSnapshot":
      return "volumeSnapshot";
    case "plugin":
      return "plugin";
    default:
      return "unknown";
  }
}

export function methodLabel(m: BackupMethod): string {
  switch (m) {
    case "objectStore":
      return "Object store";
    case "volumeSnapshot":
      return "Volume snapshot";
    case "plugin":
      return "Plugin";
    case "unknown":
      return "—";
  }
}

export function eventBadgeVariant(status: BackupEventStatus): StatusBadgeVariant {
  switch (status) {
    case "completed":
    case "ready":
      return "healthy";
    case "failed":
      return "error";
    case "running":
    case "notReady":
      return "pending";
    case "other":
      return "neutral";
  }
}

export function statusLabel(status: BackupEventStatus): string {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "running":
      return "running";
    case "ready":
      return "ready";
    case "notReady":
      return "not ready";
    case "other":
      return "unknown";
  }
}

/** Seconds between start and stop, or undefined if a bound is missing/invalid. */
export function durationSeconds(
  startedAt: string | undefined,
  stoppedAt: string | undefined,
): number | undefined {
  if (!startedAt || !stoppedAt) return undefined;
  const s = Date.parse(startedAt);
  const e = Date.parse(stoppedAt);
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return undefined;
  return Math.round((e - s) / 1000);
}

export function formatDuration(sec: number | undefined): string {
  if (sec === undefined) return "—";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

import type {
  CNPGBackup,
  CNPGCluster,
  CNPGScheduledBackup,
} from "@/panels/databases/types";
import { latestCompletedBackup, walArchivingStatus } from "@/panels/databases/databasesDisplay";
import type {
  BackupEvent,
  BackupGroup,
  BackupRow,
  BackupsView,
  KindAccess,
  SnapshotChild,
  SnapshotRow,
  VolumeSnapshot,
} from "./types";

const CNPG_CLUSTER_LABEL = "cnpg.io/cluster";
const OTHER_KEY = "__other__";

function nsOf(m: { namespace?: string }): string {
  return m.namespace ?? "default";
}

/** Fully-qualified `ns/name` keys of every snapshot a Backup run references. */
function ownedSnapshotNames(backups: CNPGBackup[]): Set<string> {
  const names = new Set<string>();
  for (const b of backups) {
    for (const el of b.status?.backupSnapshotStatus?.elements ?? []) {
      if (el.name) names.add(`${nsOf(b.metadata)}/${el.name}`);
    }
  }
  return names;
}

export function toBackupRow(
  b: CNPGBackup,
  snapshotsByName: Map<string, VolumeSnapshot>,
): BackupRow {
  const ns = nsOf(b.metadata);
  const children: SnapshotChild[] = (b.status?.backupSnapshotStatus?.elements ?? [])
    .map((el) => el.name)
    .filter((n): n is string => !!n)
    .map((n) => ({
      name: n,
      ready: snapshotsByName.get(`${ns}/${n}`)?.status?.readyToUse === true,
    }));
  return {
    id: b.metadata.uid ?? `${ns}/${b.metadata.name}`,
    kind: "cnpgBackup",
    name: b.metadata.name,
    namespace: ns,
    cluster: b.spec?.cluster?.name ?? "",
    method: backupMethod(b.spec?.method),
    phase: b.status?.phase ?? "",
    status: backupStatus(b.status?.phase),
    finishedAt: b.status?.stoppedAt ?? b.metadata.creationTimestamp,
    startedAt: b.status?.startedAt,
    durationSec: durationSeconds(b.status?.startedAt, b.status?.stoppedAt),
    beginWal: b.status?.beginWal,
    endWal: b.status?.endWal,
    snapshots: children,
  };
}

export function toSnapshotRow(s: VolumeSnapshot): SnapshotRow {
  const ready = s.status?.readyToUse === true;
  return {
    id: s.metadata.uid ?? `${nsOf(s.metadata)}/${s.metadata.name}`,
    kind: "volumeSnapshot",
    name: s.metadata.name,
    namespace: nsOf(s.metadata),
    ready,
    status: ready ? "ready" : "notReady",
    sourcePvc: s.spec?.source?.persistentVolumeClaimName,
    snapshotClass: s.spec?.volumeSnapshotClassName,
    restoreSize: s.status?.restoreSize,
    createdAt: s.status?.creationTime ?? s.metadata.creationTimestamp,
  };
}

function eventTime(e: BackupEvent): number {
  const iso = e.kind === "cnpgBackup" ? (e.finishedAt ?? e.startedAt) : e.createdAt;
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Group CNPG Backups + VolumeSnapshots by database.
 * - One group per CNPG Cluster (kept even with no events, so each DB is visible).
 * - A Backup run that isn't tied to a loaded Cluster still gets a placeholder group.
 * - A VolumeSnapshot referenced by a Backup's snapshot elements nests under that
 *   Backup (not a top-level row).
 * - A cnpg.io/cluster-labeled snapshot with no parent Backup becomes a row in its
 *   cluster group.
 * - Everything else lands in the "Other snapshots" group.
 */
export function buildBackupGroups(args: {
  cnpgClusters: CNPGCluster[];
  backups: CNPGBackup[];
  snapshots: VolumeSnapshot[];
  scheduledBackups: CNPGScheduledBackup[];
}): BackupGroup[] {
  const { cnpgClusters, backups, snapshots, scheduledBackups } = args;

  const snapshotsByName = new Map<string, VolumeSnapshot>();
  for (const s of snapshots) {
    snapshotsByName.set(`${nsOf(s.metadata)}/${s.metadata.name}`, s);
  }
  const owned = ownedSnapshotNames(backups);

  const groups = new Map<string, BackupGroup>();

  for (const c of cnpgClusters) {
    const ns = nsOf(c.metadata);
    const schedule = scheduledBackups.find(
      (sb) => sb.spec?.cluster?.name === c.metadata.name && nsOf(sb.metadata) === ns,
    )?.spec?.schedule;
    groups.set(`${ns}/${c.metadata.name}`, {
      key: c.metadata.uid ?? `${ns}/${c.metadata.name}`,
      title: c.metadata.name,
      namespace: ns,
      kind: "cnpg",
      engine: "postgres",
      lastBackup: latestCompletedBackup(backups, c.metadata.name, ns),
      schedule,
      wal: walArchivingStatus(c),
      cluster: c,
      events: [],
    });
  }

  for (const b of backups) {
    const ns = nsOf(b.metadata);
    const clusterName = b.spec?.cluster?.name ?? "";
    const gkey = `${ns}/${clusterName}`;
    let g = groups.get(gkey);
    if (!g) {
      g = {
        key: gkey,
        title: clusterName || "(unknown cluster)",
        namespace: ns,
        kind: "cnpg",
        engine: "postgres",
        events: [],
      };
      groups.set(gkey, g);
    }
    g.events.push(toBackupRow(b, snapshotsByName));
  }

  for (const s of snapshots) {
    const ns = nsOf(s.metadata);
    if (owned.has(`${ns}/${s.metadata.name}`)) continue; // nested under its Backup
    const clusterLabel = s.metadata.labels?.[CNPG_CLUSTER_LABEL];
    const clusterGroup = clusterLabel ? groups.get(`${ns}/${clusterLabel}`) : undefined;
    if (clusterGroup) {
      clusterGroup.events.push(toSnapshotRow(s));
      continue;
    }
    let other = groups.get(OTHER_KEY);
    if (!other) {
      other = { key: OTHER_KEY, title: "Other snapshots", kind: "other", events: [] };
      groups.set(OTHER_KEY, other);
    }
    other.events.push(toSnapshotRow(s));
  }

  for (const g of groups.values()) {
    g.events.sort((a, b) => eventTime(b) - eventTime(a));
  }

  return [...groups.values()]
    .filter((g) => g.kind === "cnpg" || g.events.length > 0)
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "other" ? 1 : -1;
      return a.title.localeCompare(b.title);
    });
}

/** Filter groups by query: keep a group if its title matches, else its matching events. */
export function filterGroups(groups: BackupGroup[], query: string): BackupGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  const out: BackupGroup[] = [];
  for (const g of groups) {
    if (g.title.toLowerCase().includes(q)) {
      out.push(g);
      continue;
    }
    const events = g.events.filter((e) => e.name.toLowerCase().includes(q));
    if (events.length > 0) out.push({ ...g, events });
  }
  return out;
}

/** Decide what the panel body renders. */
export function backupsView(args: {
  isLoading: boolean;
  groups: BackupGroup[];
  backupsAccess?: KindAccess;
  snapshotsAccess?: KindAccess;
}): BackupsView {
  const { isLoading, groups, backupsAccess, snapshotsAccess } = args;
  if (groups.length > 0) return { kind: "list", groups };
  if (isLoading) return { kind: "loading" };
  const forbidden: string[] = [];
  if (backupsAccess && backupsAccess.status !== "ok") {
    forbidden.push("backups.postgresql.cnpg.io");
  }
  if (snapshotsAccess && snapshotsAccess.status !== "ok") {
    forbidden.push("volumesnapshots.snapshot.storage.k8s.io");
  }
  if (forbidden.length > 0) return { kind: "forbidden", forbiddenKinds: forbidden };
  return { kind: "empty" };
}

export interface FleetSummary {
  databases: number;
  runs: number;
  failing: number;
}

/**
 * Fleet-wide counts for the summary strip. Only CNPG groups are "databases"
 * ("Other snapshots" is excluded). A database is "failing" when its WAL is
 * failing or its most-recent event is a failed backup. `runs` counts CNPG
 * Backup events across all databases.
 */
export function fleetSummary(groups: BackupGroup[]): FleetSummary {
  const dbs = groups.filter((g) => g.kind === "cnpg");
  let runs = 0;
  let failing = 0;
  for (const g of dbs) {
    const backups = g.events.filter((e) => e.kind === "cnpgBackup");
    runs += backups.length;
    const walFailing = g.wal === "failing";
    const latestFailed = backups[0]?.kind === "cnpgBackup" && backups[0].status === "failed";
    if (walFailing || latestFailed) failing += 1;
  }
  return { databases: dbs.length, runs, failing };
}
