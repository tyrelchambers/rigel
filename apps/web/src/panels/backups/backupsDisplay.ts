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
