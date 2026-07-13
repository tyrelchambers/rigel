import { describe, expect, it } from "vitest";
import {
  backupMethod,
  backupsView,
  backupStatus,
  buildBackupGroups,
  durationSeconds,
  eventBadgeVariant,
  filterGroups,
  fleetSummary,
  formatDuration,
  methodLabel,
  statusLabel,
} from "./backupsDisplay";
import type { CNPGBackup, CNPGCluster, CNPGScheduledBackup } from "@/panels/databases/types";
import type { VolumeSnapshot } from "./types";

describe("backupStatus", () => {
  it("maps CNPG phases to a normalized status", () => {
    expect(backupStatus("completed")).toBe("completed");
    expect(backupStatus("failed")).toBe("failed");
    expect(backupStatus("running")).toBe("running");
    expect(backupStatus("started")).toBe("running");
    expect(backupStatus("pending")).toBe("running");
    expect(backupStatus("weird")).toBe("other");
    expect(backupStatus(undefined)).toBe("other");
  });
});

describe("backupMethod / methodLabel", () => {
  it("maps CNPG spec.method values", () => {
    expect(backupMethod("barmanObjectStore")).toBe("objectStore");
    expect(backupMethod("volumeSnapshot")).toBe("volumeSnapshot");
    expect(backupMethod("plugin")).toBe("plugin");
    expect(backupMethod(undefined)).toBe("unknown");
  });
  it("labels methods for display", () => {
    expect(methodLabel("objectStore")).toBe("Object store");
    expect(methodLabel("volumeSnapshot")).toBe("Volume snapshot");
    expect(methodLabel("plugin")).toBe("Plugin");
    expect(methodLabel("unknown")).toBe("—");
  });
});

describe("eventBadgeVariant / statusLabel", () => {
  it("maps status to a StatusBadge variant", () => {
    expect(eventBadgeVariant("completed")).toBe("healthy");
    expect(eventBadgeVariant("ready")).toBe("healthy");
    expect(eventBadgeVariant("failed")).toBe("error");
    expect(eventBadgeVariant("running")).toBe("pending");
    expect(eventBadgeVariant("notReady")).toBe("pending");
    expect(eventBadgeVariant("other")).toBe("neutral");
  });
  it("labels status", () => {
    expect(statusLabel("notReady")).toBe("not ready");
    expect(statusLabel("completed")).toBe("completed");
  });
});

describe("durationSeconds / formatDuration", () => {
  it("computes seconds between start and stop", () => {
    expect(
      durationSeconds("2026-07-13T10:00:00Z", "2026-07-13T10:01:30Z"),
    ).toBe(90);
  });
  it("returns undefined when a bound is missing or invalid", () => {
    expect(durationSeconds(undefined, "2026-07-13T10:01:30Z")).toBeUndefined();
    expect(durationSeconds("2026-07-13T10:05:00Z", "2026-07-13T10:00:00Z")).toBeUndefined();
  });
  it("formats durations compactly", () => {
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(90)).toBe("1m 30s");
    expect(formatDuration(120)).toBe("2m");
    expect(formatDuration(3600)).toBe("1h");
    expect(formatDuration(3720)).toBe("1h 2m");
  });
});

function cluster(name: string, ns = "default"): CNPGCluster {
  return {
    metadata: { name, namespace: ns, uid: `uid-${name}` },
    spec: { instances: 1 },
    status: { phase: "Cluster in healthy state", readyInstances: 1, instances: 1 },
  };
}

function backup(
  name: string,
  clusterName: string,
  phase: string,
  opts: Partial<{ stoppedAt: string; method: string; elements: string[]; ns: string }> = {},
): CNPGBackup {
  return {
    metadata: { name, namespace: opts.ns ?? "default", uid: `uid-${name}` },
    spec: { cluster: { name: clusterName }, method: opts.method ?? "barmanObjectStore" },
    status: {
      phase,
      stoppedAt: opts.stoppedAt,
      backupSnapshotStatus: opts.elements
        ? { elements: opts.elements.map((n) => ({ name: n })) }
        : undefined,
    },
  };
}

function snapshot(
  name: string,
  opts: Partial<{ ns: string; cluster: string; ready: boolean; pvc: string }> = {},
): VolumeSnapshot {
  return {
    metadata: {
      name,
      namespace: opts.ns ?? "default",
      uid: `uid-${name}`,
      labels: opts.cluster ? { "cnpg.io/cluster": opts.cluster } : undefined,
    },
    spec: { source: { persistentVolumeClaimName: opts.pvc } },
    status: { readyToUse: opts.ready ?? true },
  };
}

describe("buildBackupGroups", () => {
  it("groups CNPG backups under their cluster, newest first", () => {
    const groups = buildBackupGroups({
      cnpgClusters: [cluster("db")],
      backups: [
        backup("b1", "db", "completed", { stoppedAt: "2026-07-10T00:00:00Z" }),
        backup("b2", "db", "completed", { stoppedAt: "2026-07-12T00:00:00Z" }),
      ],
      snapshots: [],
      scheduledBackups: [],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe("db");
    expect(groups[0].kind).toBe("cnpg");
    expect(groups[0].events.map((e) => e.name)).toEqual(["b2", "b1"]);
  });

  it("nests CNPG-owned snapshots under their Backup, not as rows", () => {
    const groups = buildBackupGroups({
      cnpgClusters: [cluster("db")],
      backups: [
        backup("b1", "db", "completed", {
          stoppedAt: "2026-07-12T00:00:00Z",
          method: "volumeSnapshot",
          elements: ["snap-a"],
        }),
      ],
      snapshots: [snapshot("snap-a", { cluster: "db", ready: true })],
      scheduledBackups: [],
    });
    expect(groups).toHaveLength(1);
    // Only the Backup is a top-level event; the snapshot is nested.
    expect(groups[0].events).toHaveLength(1);
    const row = groups[0].events[0];
    expect(row.kind).toBe("cnpgBackup");
    if (row.kind === "cnpgBackup") {
      expect(row.snapshots).toEqual([{ name: "snap-a", ready: true }]);
    }
  });

  it("puts a cnpg.io/cluster-labeled snapshot with no parent Backup into its cluster group", () => {
    const groups = buildBackupGroups({
      cnpgClusters: [cluster("db")],
      backups: [],
      snapshots: [snapshot("snap-x", { cluster: "db", ready: false })],
      scheduledBackups: [],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe("db");
    expect(groups[0].events).toHaveLength(1);
    expect(groups[0].events[0].kind).toBe("volumeSnapshot");
  });

  it("puts unassociated snapshots into an 'Other snapshots' group, sorted last", () => {
    const groups = buildBackupGroups({
      cnpgClusters: [cluster("db")],
      backups: [],
      snapshots: [snapshot("loose", { pvc: "data-0" })],
      scheduledBackups: [],
    });
    expect(groups.map((g) => g.title)).toEqual(["db", "Other snapshots"]);
    const other = groups[1];
    expect(other.kind).toBe("other");
    expect(other.events[0].kind).toBe("volumeSnapshot");
  });

  it("attaches schedule + WAL health to the CNPG group header", () => {
    const sb: CNPGScheduledBackup = {
      metadata: { name: "sb", namespace: "default" },
      spec: { schedule: "0 0 * * *", cluster: { name: "db" } },
    };
    const c = cluster("db");
    c.status = { ...c.status, conditions: [{ type: "ContinuousArchiving", status: "True" }] };
    const groups = buildBackupGroups({
      cnpgClusters: [c],
      backups: [backup("b1", "db", "completed", { stoppedAt: "2026-07-12T00:00:00Z" })],
      snapshots: [],
      scheduledBackups: [sb],
    });
    expect(groups[0].schedule).toBe("0 0 * * *");
    expect(groups[0].wal).toBe("healthy");
    expect(groups[0].lastBackup).toBe("2026-07-12T00:00:00Z");
    expect(groups[0].cluster).toBe(c);
  });
});

describe("filterGroups", () => {
  const groups = buildBackupGroups({
    cnpgClusters: [cluster("alpha"), cluster("beta")],
    backups: [
      backup("alpha-daily", "alpha", "completed", { stoppedAt: "2026-07-12T00:00:00Z" }),
      backup("beta-daily", "beta", "completed", { stoppedAt: "2026-07-12T00:00:00Z" }),
    ],
    snapshots: [],
    scheduledBackups: [],
  });

  it("keeps a group whose title matches", () => {
    expect(filterGroups(groups, "alpha").map((g) => g.title)).toEqual(["alpha"]);
  });
  it("keeps only matching events when the title does not match", () => {
    const r = filterGroups(groups, "beta-daily");
    expect(r.map((g) => g.title)).toEqual(["beta"]);
    expect(r[0].events).toHaveLength(1);
  });
  it("returns all groups for an empty query", () => {
    expect(filterGroups(groups, "  ")).toHaveLength(2);
  });
});

describe("backupsView", () => {
  const groups = buildBackupGroups({
    cnpgClusters: [cluster("db")],
    backups: [backup("b1", "db", "completed", { stoppedAt: "2026-07-12T00:00:00Z" })],
    snapshots: [],
    scheduledBackups: [],
  });

  it("shows the list when groups exist", () => {
    expect(backupsView({ isLoading: false, groups }).kind).toBe("list");
  });
  it("shows loading when empty and still loading", () => {
    expect(backupsView({ isLoading: true, groups: [] }).kind).toBe("loading");
  });
  it("reports forbidden CRDs when empty, not loading, and access denied", () => {
    const v = backupsView({
      isLoading: false,
      groups: [],
      backupsAccess: { status: "forbidden" },
    });
    expect(v.kind).toBe("forbidden");
    if (v.kind === "forbidden") {
      expect(v.forbiddenKinds).toEqual(["backups.postgresql.cnpg.io"]);
    }
  });
  it("shows empty when nothing is present and access is ok", () => {
    expect(
      backupsView({ isLoading: false, groups: [], backupsAccess: { status: "ok" } }).kind,
    ).toBe("empty");
  });
});

describe("fleetSummary", () => {
  it("counts databases, runs, and failing databases", () => {
    const c1 = cluster("alpha");
    c1.status = { ...c1.status, conditions: [{ type: "ContinuousArchiving", status: "False" }] };
    const groups = buildBackupGroups({
      cnpgClusters: [c1, cluster("beta")],
      backups: [
        backup("a1", "alpha", "completed", { stoppedAt: "2026-07-12T00:00:00Z" }),
        backup("b1", "beta", "completed", { stoppedAt: "2026-07-12T00:00:00Z" }),
        backup("b2", "beta", "failed", { stoppedAt: "2026-07-12T01:00:00Z" }),
      ],
      snapshots: [snapshot("loose", { pvc: "data-0" })],
      scheduledBackups: [],
    });
    const s = fleetSummary(groups);
    // alpha (WAL failing) + beta (latest run failed) both count as failing; "Other" is not a database.
    expect(s).toEqual({ databases: 2, runs: 3, failing: 2 });
  });
});
