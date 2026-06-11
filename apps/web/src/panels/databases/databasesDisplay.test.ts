import { describe, expect, test } from "vitest";
import type {
  CNPGBackup,
  CNPGCluster,
  CNPGScheduledBackup,
  DatabaseInstance,
  DatabasePodRaw,
  WorkloadDB,
} from "./types";
import {
  actionLabel,
  actionToBlock,
  buildInstances,
  capabilities,
  compareInstances,
  connectionString,
  detectKindFromImage,
  dsn,
  instanceFromCNPG,
  instanceFromWorkload,
  latestCompletedBackup,
  matchPods,
  matchesDatabase,
  podNodes,
  readyColorClass,
  relativeAge,
  sortInstances,
  sourceBadgeLabel,
  walArchivingStatus,
} from "./databasesDisplay";
import type { DatabaseSecret } from "./types";

// --- fixtures --------------------------------------------------------------

function cnpg(overrides: Partial<CNPGCluster> = {}): CNPGCluster {
  return {
    metadata: {
      name: "pg",
      namespace: "default",
      uid: "cnpg-1",
      creationTimestamp: "2026-06-07T00:00:00Z",
      ...overrides.metadata,
    },
    spec: { instances: 3, imageName: "ghcr.io/cloudnative-pg/postgresql:16.3", ...overrides.spec },
    status: {
      readyInstances: 3,
      phase: "Cluster in healthy state",
      currentPrimary: "pg-1",
      ...overrides.status,
    },
  };
}

function workload(overrides: Partial<WorkloadDB> = {}): WorkloadDB {
  return {
    metadata: { name: "redis", namespace: "monitoring", uid: "w-1", ...overrides.metadata },
    spec: {
      replicas: 2,
      selector: { matchLabels: { app: "redis" } },
      template: { spec: { containers: [{ name: "redis", image: "redis:7" }] } },
      ...overrides.spec,
    },
    status: { readyReplicas: 1, ...overrides.status },
  };
}

// --- relativeAge -----------------------------------------------------------

describe("relativeAge", () => {
  const now = Date.parse("2026-06-09T00:00:00Z");
  test("formats seconds/minutes/hours/days", () => {
    expect(relativeAge("2026-06-08T23:59:55Z", now)).toBe("5s");
    expect(relativeAge("2026-06-08T23:57:00Z", now)).toBe("3m");
    expect(relativeAge("2026-06-08T22:00:00Z", now)).toBe("2h");
    expect(relativeAge("2026-06-07T00:00:00Z", now)).toBe("2d");
  });
  test("missing/invalid → em dash", () => {
    expect(relativeAge(undefined, now)).toBe("—");
    expect(relativeAge("not-a-date", now)).toBe("—");
  });
});

// --- detectKindFromImage ---------------------------------------------------

describe("detectKindFromImage", () => {
  test("matches all 13 database kinds case-insensitively", () => {
    expect(detectKindFromImage("postgres:16")).toBe("postgres");
    expect(detectKindFromImage("ghcr.io/x/PostgreSQL:1")).toBe("postgres");
    expect(detectKindFromImage("mysql:8")).toBe("mysql");
    expect(detectKindFromImage("mariadb:11")).toBe("mariadb");
    expect(detectKindFromImage("mongo:7")).toBe("mongo");
    expect(detectKindFromImage("library/mongodb:6")).toBe("mongo");
    expect(detectKindFromImage("redis:7")).toBe("redis");
    expect(detectKindFromImage("valkey/valkey:8")).toBe("valkey");
    expect(detectKindFromImage("keydb:6")).toBe("keydb");
    expect(detectKindFromImage("clickhouse/clickhouse-server:24")).toBe("clickhouse");
    expect(detectKindFromImage("clickhouse:24")).toBe("clickhouse");
    expect(detectKindFromImage("elasticsearch:8")).toBe("elasticsearch");
    expect(detectKindFromImage("opensearchproject/opensearch:2")).toBe("opensearch");
    expect(detectKindFromImage("cassandra:5")).toBe("cassandra");
    expect(detectKindFromImage("scylladb/scylla:6")).toBe("scylla");
    expect(detectKindFromImage("scylla:6")).toBe("scylla");
    expect(detectKindFromImage("dragonflydb/dragonfly:1")).toBe("dragonfly");
    expect(detectKindFromImage("dragonfly:1")).toBe("dragonfly");
  });

  test("excludes operators, exporters, and known sidecars", () => {
    expect(detectKindFromImage("ghcr.io/cloudnative-pg/cloudnative-pg-operator:1")).toBeNull();
    expect(detectKindFromImage("prometheuscommunity/postgres-exporter:0.15")).toBeNull();
    expect(detectKindFromImage("bitnami/pgbouncer:1")).toBeNull();
    expect(detectKindFromImage("bitnami/pgpool:4")).toBeNull();
    expect(detectKindFromImage("tailscale/tailscale:latest")).toBeNull();
    expect(detectKindFromImage("redis-exporter:1")).toBeNull();
  });

  test("non-database / missing image → null", () => {
    expect(detectKindFromImage("nginx:1.25")).toBeNull();
    expect(detectKindFromImage(undefined)).toBeNull();
  });

  test("registry host does not false-match", () => {
    // host contains 'redis' but the image is nginx → not a redis DB
    expect(detectKindFromImage("redis.example.com/nginx:1")).toBeNull();
  });
});

// --- instanceFromCNPG ------------------------------------------------------

describe("instanceFromCNPG", () => {
  test("normalizes a healthy CNPG cluster with a scheduled backup", () => {
    const sb: CNPGScheduledBackup = {
      metadata: { name: "pg-backup", namespace: "default" },
      spec: { schedule: "0 0 * * *", cluster: { name: "pg" } },
    };
    const inst = instanceFromCNPG(
      cnpg({ status: { readyInstances: 3, phase: "Cluster in healthy state", currentPrimary: "pg-1", lastSuccessfulBackup: "2026-06-08T00:00:00Z", conditions: [{ type: "ContinuousArchiving", status: "True" }] } }),
      [sb],
    );
    expect(inst.kind).toBe("postgres");
    expect(inst.source).toBe("cnpg");
    expect(inst.desiredReplicas).toBe(3);
    expect(inst.readyReplicas).toBe(3);
    expect(inst.isHealthy).toBe(true);
    expect(inst.cnpgPrimary).toBe("pg-1");
    expect(inst.labelSelector).toEqual({ "cnpg.io/cluster": "pg" });
    expect(inst.scheduledBackup).toBe("0 0 * * *");
    expect(inst.lastBackup).toBe("2026-06-08T00:00:00Z");
    expect(inst.walArchiving).toBe("healthy");
  });

  test("desired falls back to status.instances; unhealthy and unknown phase", () => {
    const inst = instanceFromCNPG(
      cnpg({ spec: { instances: undefined }, status: { instances: 3, readyInstances: 1, phase: undefined } }),
      [],
    );
    expect(inst.desiredReplicas).toBe(3);
    expect(inst.readyReplicas).toBe(1);
    expect(inst.isHealthy).toBe(false);
    expect(inst.phaseText).toBe("Unknown");
    expect(inst.walArchiving).toBe("unknown");
    expect(inst.scheduledBackup).toBeUndefined();
  });

  test("zero desired is never healthy", () => {
    const inst = instanceFromCNPG(cnpg({ spec: { instances: 0 }, status: { readyInstances: 0 } }), []);
    expect(inst.isHealthy).toBe(false);
  });

  test("scheduled backup must match cluster name AND namespace", () => {
    const sb: CNPGScheduledBackup = {
      metadata: { name: "other", namespace: "other-ns" },
      spec: { schedule: "@daily", cluster: { name: "pg" } },
    };
    const inst = instanceFromCNPG(cnpg(), [sb]);
    expect(inst.scheduledBackup).toBeUndefined();
  });
});

// --- latestCompletedBackup + lastBackup precedence -------------------------

function backup(overrides: Partial<CNPGBackup> = {}): CNPGBackup {
  return {
    metadata: { name: "b", namespace: "default", ...overrides.metadata },
    spec: { cluster: { name: "pg" }, method: "plugin", ...overrides.spec },
    status: { phase: "completed", stoppedAt: "2026-06-10T03:13:39Z", ...overrides.status },
  };
}

describe("latestCompletedBackup", () => {
  test("returns the newest completed backup's stoppedAt", () => {
    const backups: CNPGBackup[] = [
      backup({ metadata: { name: "old" }, status: { phase: "completed", stoppedAt: "2026-06-08T03:00:00Z" } }),
      backup({ metadata: { name: "new" }, status: { phase: "completed", stoppedAt: "2026-06-10T03:13:39Z" } }),
      backup({ metadata: { name: "mid" }, status: { phase: "completed", stoppedAt: "2026-06-09T03:00:00Z" } }),
    ];
    expect(latestCompletedBackup(backups, "pg", "default")).toBe("2026-06-10T03:13:39Z");
  });

  test("ignores failed/running backups and other clusters/namespaces", () => {
    const backups: CNPGBackup[] = [
      backup({ status: { phase: "failed", stoppedAt: undefined } }),
      backup({ status: { phase: "running", stoppedAt: undefined } }),
      backup({ metadata: { name: "other-cluster" }, spec: { cluster: { name: "pg2" } }, status: { phase: "completed", stoppedAt: "2099-01-01T00:00:00Z" } }),
      backup({ metadata: { name: "other-ns", namespace: "prod" }, status: { phase: "completed", stoppedAt: "2099-01-01T00:00:00Z" } }),
      backup({ status: { phase: "completed", stoppedAt: "2026-06-05T03:00:00Z" } }),
    ];
    expect(latestCompletedBackup(backups, "pg", "default")).toBe("2026-06-05T03:00:00Z");
  });

  test("returns undefined when no completed backups match", () => {
    expect(latestCompletedBackup([], "pg", "default")).toBeUndefined();
  });
});

describe("instanceFromCNPG lastBackup precedence", () => {
  test("prefers the newest completed Backup object over status.lastSuccessfulBackup", () => {
    // The real-world bug: cluster.status.lastSuccessfulBackup is stale (frozen
    // at the legacy-method cutover) while plugin Backup objects keep completing.
    const inst = instanceFromCNPG(
      cnpg({ status: { readyInstances: 3, lastSuccessfulBackup: "2026-05-14T02:00:29Z" } }),
      [],
      [backup({ status: { phase: "completed", stoppedAt: "2026-06-10T03:13:39Z" } })],
    );
    expect(inst.lastBackup).toBe("2026-06-10T03:13:39Z");
  });

  test("falls back to status.lastSuccessfulBackup when no Backup objects exist", () => {
    const inst = instanceFromCNPG(
      cnpg({ status: { readyInstances: 3, lastSuccessfulBackup: "2026-05-14T02:00:29Z" } }),
      [],
      [],
    );
    expect(inst.lastBackup).toBe("2026-05-14T02:00:29Z");
  });
});

describe("walArchivingStatus", () => {
  test("True/False/missing → healthy/failing/unknown", () => {
    expect(walArchivingStatus(cnpg({ status: { conditions: [{ type: "ContinuousArchiving", status: "True" }] } }))).toBe("healthy");
    expect(walArchivingStatus(cnpg({ status: { conditions: [{ type: "ContinuousArchiving", status: "False" }] } }))).toBe("failing");
    expect(walArchivingStatus(cnpg({ status: { conditions: [] } }))).toBe("unknown");
  });
});

// --- instanceFromWorkload --------------------------------------------------

describe("instanceFromWorkload", () => {
  test("detects redis StatefulSet, degraded", () => {
    const inst = instanceFromWorkload(workload(), "statefulset");
    expect(inst).not.toBeNull();
    expect(inst!.kind).toBe("redis");
    expect(inst!.source).toBe("statefulset");
    expect(inst!.desiredReplicas).toBe(2);
    expect(inst!.readyReplicas).toBe(1);
    expect(inst!.isHealthy).toBe(false);
    expect(inst!.phaseText).toBe("Degraded");
    expect(inst!.image).toBe("redis:7");
    expect(inst!.labelSelector).toEqual({ app: "redis" });
  });

  test("healthy postgres Deployment", () => {
    const inst = instanceFromWorkload(
      workload({
        metadata: { name: "pg", namespace: "default", uid: "d1" },
        spec: { replicas: 1, selector: { matchLabels: { app: "pg" } }, template: { spec: { containers: [{ name: "pg", image: "postgres:16" }] } } },
        status: { readyReplicas: 1 },
      }),
      "deployment",
    );
    expect(inst!.kind).toBe("postgres");
    expect(inst!.source).toBe("deployment");
    expect(inst!.isHealthy).toBe(true);
    expect(inst!.phaseText).toBe("Healthy");
  });

  test("desired falls back to status.replicas", () => {
    const inst = instanceFromWorkload(
      workload({ spec: { replicas: undefined, selector: { matchLabels: { app: "redis" } }, template: { spec: { containers: [{ image: "redis:7" }] } } }, status: { replicas: 2, readyReplicas: 2 } }),
      "statefulset",
    );
    expect(inst!.desiredReplicas).toBe(2);
    expect(inst!.isHealthy).toBe(true);
  });

  test("returns null when no container image is a database", () => {
    const inst = instanceFromWorkload(
      workload({ spec: { template: { spec: { containers: [{ image: "nginx:1" }] } } } }),
      "deployment",
    );
    expect(inst).toBeNull();
  });

  test("skips an exporter sidecar and matches the real db container", () => {
    const inst = instanceFromWorkload(
      workload({
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: "pg" } },
          template: { spec: { containers: [{ name: "exporter", image: "postgres-exporter:1" }, { name: "db", image: "postgres:16" }] } },
        },
        status: { readyReplicas: 1 },
      }),
      "statefulset",
    );
    expect(inst!.kind).toBe("postgres");
    expect(inst!.image).toBe("postgres:16");
  });
});

// --- buildInstances + sort -------------------------------------------------

describe("buildInstances / sort", () => {
  test("combines CNPG + workloads and sorts by namespace then name", () => {
    const list = buildInstances({
      cnpgClusters: [cnpg({ metadata: { name: "pg", namespace: "default", uid: "c1" } })],
      scheduledBackups: [],
      deployments: [
        workload({ metadata: { name: "pg-dep", namespace: "default", uid: "d1" }, spec: { replicas: 1, selector: { matchLabels: { app: "pg" } }, template: { spec: { containers: [{ image: "postgres:16" }] } } }, status: { readyReplicas: 1 } }),
        workload({ metadata: { name: "nope", namespace: "default", uid: "d2" }, spec: { template: { spec: { containers: [{ image: "nginx:1" }] } } } }),
      ],
      statefulSets: [workload({ metadata: { name: "redis", namespace: "monitoring", uid: "s1" } })],
    });
    // nginx excluded; order: default/pg, default/pg-dep, monitoring/redis
    expect(list.map((i) => `${i.namespace}/${i.name}`)).toEqual([
      "default/pg",
      "default/pg-dep",
      "monitoring/redis",
    ]);
  });

  test("compareInstances orders namespace before name", () => {
    const a = { namespace: "a", name: "z" } as DatabaseInstance;
    const b = { namespace: "b", name: "a" } as DatabaseInstance;
    expect(compareInstances(a, b)).toBeLessThan(0);
  });

  test("sortInstances is stable lexicographic", () => {
    const inst = (ns: string, n: string) => ({ namespace: ns, name: n }) as DatabaseInstance;
    const sorted = sortInstances([inst("b", "x"), inst("a", "y"), inst("a", "x")]);
    expect(sorted.map((i) => `${i.namespace}/${i.name}`)).toEqual(["a/x", "a/y", "b/x"]);
  });
});

// --- matchPods -------------------------------------------------------------

describe("matchPods", () => {
  const inst = instanceFromCNPG(cnpg(), []); // selector {cnpg.io/cluster: pg}, primary pg-1, ns default
  const pods: DatabasePodRaw[] = [
    { metadata: { name: "pg-2", namespace: "default", labels: { "cnpg.io/cluster": "pg" } }, spec: { nodeName: "node-b" }, status: { phase: "Running" } },
    { metadata: { name: "pg-1", namespace: "default", labels: { "cnpg.io/cluster": "pg" } }, spec: { nodeName: "node-a" }, status: { phase: "Running" } },
    { metadata: { name: "other", namespace: "default", labels: { "cnpg.io/cluster": "elsewhere" } }, status: { phase: "Running" } },
    { metadata: { name: "pg-1", namespace: "other", labels: { "cnpg.io/cluster": "pg" } }, status: { phase: "Running" } },
  ];

  test("matches by selector + namespace, sorts by name, flags primary", () => {
    const matched = matchPods(inst, pods);
    expect(matched.map((p) => p.name)).toEqual(["pg-1", "pg-2"]);
    expect(matched[0].isPrimary).toBe(true);
    expect(matched[1].isPrimary).toBe(false);
    expect(matched[0].node).toBe("node-a");
  });

  test("returns empty when selector matches nothing", () => {
    const wl = instanceFromWorkload(workload(), "statefulset")!; // selector {app: redis}, ns monitoring
    expect(matchPods(wl, pods)).toEqual([]);
  });

  test("podNodes returns distinct nodes in order", () => {
    const matched = matchPods(inst, pods);
    expect(podNodes(matched)).toEqual(["node-a", "node-b"]);
  });
});

// --- search ----------------------------------------------------------------

describe("matchesDatabase", () => {
  const inst = instanceFromWorkload(workload(), "statefulset")!; // redis, monitoring, redis:7, {app:redis}

  test("empty query matches", () => {
    expect(matchesDatabase(inst, "")).toBe(true);
    expect(matchesDatabase(inst, "   ")).toBe(true);
  });
  test("matches name, namespace, kind, image, label key/value (case-insensitive)", () => {
    expect(matchesDatabase(inst, "REDIS")).toBe(true);
    expect(matchesDatabase(inst, "monitoring")).toBe(true);
    expect(matchesDatabase(inst, "redis:7")).toBe(true);
    expect(matchesDatabase(inst, "app")).toBe(true);
  });
  test("non-match returns false", () => {
    expect(matchesDatabase(inst, "postgres")).toBe(false);
  });
});

// --- connectionString ------------------------------------------------------

describe("connectionString", () => {
  test("CNPG uses service .svc host and pg scheme/port", () => {
    expect(
      connectionString({ kind: "postgres", source: "cnpg", target: "pg-rw", namespace: "default", username: "app", dbname: "app" }),
    ).toBe("postgresql://app@pg-rw.default.svc:5432/app");
  });
  test("generic uses pod host without .svc", () => {
    expect(
      connectionString({ kind: "redis", source: "statefulset", target: "redis-0", namespace: "monitoring" }),
    ).toBe("redis://redis-0.monitoring:6379");
  });
  test("explicit port overrides default", () => {
    expect(
      connectionString({ kind: "mysql", source: "deployment", target: "db", namespace: "default", port: 13306 }),
    ).toBe("mysql://db.default:13306");
  });
});

// --- misc badge helpers ----------------------------------------------------

describe("badge helpers", () => {
  test("sourceBadgeLabel", () => {
    expect(sourceBadgeLabel("cnpg")).toBe("CNPG");
    expect(sourceBadgeLabel("deployment")).toBe("DEPLOY");
    expect(sourceBadgeLabel("statefulset")).toBe("STS");
  });
  test("readyColorClass switches on health", () => {
    expect(readyColorClass(true)).toContain("green");
    expect(readyColorClass(false)).toContain("red");
  });
});

// ---------------------------------------------------------------------------
// Capabilities + action bar
// ---------------------------------------------------------------------------

function cnpgInstance(overrides: Partial<DatabaseInstance> = {}): DatabaseInstance {
  return {
    id: "cnpg-1",
    name: "pg",
    namespace: "default",
    kind: "postgres",
    source: "cnpg",
    desiredReplicas: 3,
    readyReplicas: 3,
    phaseText: "Cluster in healthy state",
    isHealthy: true,
    labelSelector: { "cnpg.io/cluster": "pg" },
    cnpgPrimary: "pg-1",
    ...overrides,
  };
}

function imgInstance(overrides: Partial<DatabaseInstance> = {}): DatabaseInstance {
  return {
    id: "dep-1",
    name: "my-redis",
    namespace: "default",
    kind: "redis",
    source: "deployment",
    desiredReplicas: 1,
    readyReplicas: 1,
    phaseText: "Healthy",
    isHealthy: true,
    labelSelector: { app: "my-redis" },
    ...overrides,
  };
}

function runningPod(name: string, labels: Record<string, string>): DatabasePodRaw {
  return {
    metadata: { name, namespace: "default", labels },
    status: { phase: "Running" },
  };
}

const b64 = (s: string) => btoa(s);

describe("capabilities — CNPG", () => {
  const cnpgPods = [
    runningPod("pg-1", { "cnpg.io/cluster": "pg" }),
    runningPod("pg-2", { "cnpg.io/cluster": "pg" }),
    runningPod("pg-3", { "cnpg.io/cluster": "pg" }),
  ];
  const appSecret: DatabaseSecret = {
    metadata: { name: "pg-app", namespace: "default" },
    data: { username: b64("app"), password: b64("s3cr3t") },
  };

  function caps(pluginAvailable: boolean, inst = cnpgInstance(), pods = cnpgPods) {
    return capabilities({
      instance: inst,
      pods,
      cnpgCluster: undefined,
      scheduledBackups: [],
      secrets: [appSecret],
      cnpgPluginAvailable: pluginAvailable,
    });
  }

  function find(c: ReturnType<typeof caps>, type: string) {
    return c.actions.find((a) => a.action.type === type);
  }

  test("with plugin + standby: all actions enabled", () => {
    const c = caps(true);
    expect(find(c, "backupNow")?.enabled).toBe(true);
    const sw = find(c, "switchover");
    expect(sw?.enabled).toBe(true);
    expect(sw?.action).toEqual({ type: "switchover", to: "pg-2" }); // first non-primary sorted
    expect(find(c, "hibernate")?.enabled).toBe(true);
    expect(find(c, "scale")?.enabled).toBe(true);
    expect(find(c, "portForward")?.enabled).toBe(true);
    expect(find(c, "revealCredentials")?.enabled).toBe(true);
    expect(find(c, "copyDSN")?.enabled).toBe(true);
  });

  test("without plugin: CNPG-specific actions disabled with plugin reason", () => {
    const c = caps(false);
    for (const t of ["backupNow", "switchover", "hibernate"]) {
      const item = find(c, t);
      expect(item?.enabled).toBe(false);
    }
    expect(find(c, "backupNow")?.disabledReason).toBe("Requires the kubectl-cnpg plugin");
    // Non-CNPG actions remain enabled.
    expect(find(c, "scale")?.enabled).toBe(true);
    expect(find(c, "portForward")?.enabled).toBe(true);
    expect(find(c, "copyDSN")?.enabled).toBe(true);
  });

  test("no standby (only primary running): switchover disabled with standby reason", () => {
    const c = caps(true, cnpgInstance(), [runningPod("pg-1", { "cnpg.io/cluster": "pg" })]);
    const sw = find(c, "switchover");
    expect(sw?.enabled).toBe(false);
    expect(sw?.disabledReason).toBe("No ready standby to promote");
    expect(sw?.action).toEqual({ type: "switchover", to: "" });
  });

  test("no primary elected: switchover disabled even with running pods", () => {
    const c = caps(true, cnpgInstance({ cnpgPrimary: undefined }));
    expect(find(c, "switchover")?.enabled).toBe(false);
    expect(find(c, "switchover")?.disabledReason).toBe("No ready standby to promote");
  });

  test("hibernated (readyReplicas === 0): show Resume, hide Hibernate", () => {
    const c = caps(true, cnpgInstance({ readyReplicas: 0 }), []);
    const hib = find(c, "hibernate");
    expect(hib?.action).toEqual({ type: "hibernate", on: false }); // Resume
    expect(actionLabel(hib!.action)).toBe("Resume");
  });

  test("healthy (readyReplicas > 0): show Hibernate, hide Resume", () => {
    const c = caps(true);
    const hib = find(c, "hibernate");
    expect(hib?.action).toEqual({ type: "hibernate", on: true });
    expect(actionLabel(hib!.action)).toBe("Hibernate");
  });

  test("unhealthy (ready < desired) does not block actions", () => {
    const c = caps(true, cnpgInstance({ readyReplicas: 1, isHealthy: false }));
    expect(find(c, "backupNow")?.enabled).toBe(true);
    expect(find(c, "scale")?.enabled).toBe(true);
  });

  test("connection info: svc target, app secret, decoded username, dbName app", () => {
    const c = caps(true);
    expect(c.connection).toEqual({
      targetKind: "svc",
      targetName: "pg-rw",
      namespace: "default",
      port: 5432,
      scheme: "postgresql",
      secretName: "pg-app",
      username: "app",
      dbName: "app",
    });
  });

  test("backup info: schedule + WAL from cluster condition", () => {
    const cluster: CNPGCluster = {
      metadata: { name: "pg", namespace: "default", uid: "x" },
      status: { conditions: [{ type: "ContinuousArchiving", status: "True" }] },
    };
    const c = capabilities({
      instance: cnpgInstance({ lastBackup: "2026-06-09T00:00:00Z" }),
      pods: cnpgPods,
      cnpgCluster: cluster,
      scheduledBackups: [
        { metadata: { name: "sb", namespace: "default" }, spec: { schedule: "0 4 * * *", cluster: { name: "pg" } } },
      ],
      secrets: [appSecret],
      cnpgPluginAvailable: true,
    });
    expect(c.backupInfo).toEqual({
      lastBackup: "2026-06-09T00:00:00Z",
      schedule: "0 4 * * *",
      walArchivingHealthy: true,
    });
  });
});

describe("capabilities — image-detected", () => {
  const pod = {
    metadata: { name: "my-redis-0", namespace: "default", labels: { app: "my-redis" } },
    status: { phase: "Running" },
    spec: { containers: [{ envFrom: [{ secretRef: { name: "redis-secret" } }] }] },
  } as DatabasePodRaw;

  test("deployment with running pod + secret: scale/port-forward/credentials/copy-dsn enabled", () => {
    const c = capabilities({
      instance: imgInstance(),
      pods: [pod],
      scheduledBackups: [],
      secrets: [],
      cnpgPluginAvailable: false,
    });
    const types = c.actions.map((a) => a.action.type);
    expect(types).toEqual(["scale", "portForward", "revealCredentials", "copyDSN"]);
    expect(c.actions.every((a) => a.enabled)).toBe(true);
    expect(c.connection).toEqual({
      targetKind: "pod",
      targetName: "my-redis-0",
      namespace: "default",
      port: 6379,
      scheme: "redis",
      secretName: "redis-secret",
      username: undefined,
      dbName: undefined,
    });
  });

  test("no running pods: port-forward omitted, no connection", () => {
    const c = capabilities({
      instance: imgInstance(),
      pods: [],
      scheduledBackups: [],
      secrets: [],
      cnpgPluginAvailable: false,
    });
    const types = c.actions.map((a) => a.action.type);
    expect(types).not.toContain("portForward");
    expect(c.connection).toBeUndefined();
  });

  test("no discoverable secret: credentials omitted", () => {
    const noSecretPod = {
      metadata: { name: "my-redis-0", namespace: "default", labels: { app: "my-redis" } },
      status: { phase: "Running" },
      spec: { containers: [{}] },
    } as DatabasePodRaw;
    const c = capabilities({
      instance: imgInstance(),
      pods: [noSecretPod],
      scheduledBackups: [],
      secrets: [],
      cnpgPluginAvailable: false,
    });
    const types = c.actions.map((a) => a.action.type);
    expect(types).not.toContain("revealCredentials");
    expect(c.connection?.secretName).toBeUndefined();
  });

  test("statefulset: no CNPG-specific actions", () => {
    const c = capabilities({
      instance: imgInstance({ source: "statefulset" }),
      pods: [pod],
      scheduledBackups: [],
      secrets: [],
      cnpgPluginAvailable: true,
    });
    const types = c.actions.map((a) => a.action.type);
    expect(types).not.toContain("backupNow");
    expect(types).not.toContain("switchover");
    expect(types).not.toContain("hibernate");
  });

  test("clickhouse uses native port 9000 (operator), not display 8123", () => {
    const c = capabilities({
      instance: imgInstance({ kind: "clickhouse" }),
      pods: [pod],
      scheduledBackups: [],
      secrets: [],
      cnpgPluginAvailable: false,
    });
    expect(c.connection?.port).toBe(9000);
  });
});

describe("dsn / actionLabel / actionToBlock", () => {
  test("dsn CNPG: scheme://user@target.ns.svc:port/db", () => {
    expect(
      dsn({
        targetKind: "svc",
        targetName: "pg-rw",
        namespace: "default",
        port: 5432,
        scheme: "postgresql",
        username: "app",
        dbName: "app",
      }),
    ).toBe("postgresql://app@pg-rw.default.svc:5432/app");
  });

  test("dsn image-detected: no user, no svc suffix, no db", () => {
    expect(
      dsn({
        targetKind: "pod",
        targetName: "my-redis-0",
        namespace: "default",
        port: 6379,
        scheme: "redis",
      }),
    ).toBe("redis://my-redis-0.default:6379");
  });

  test("actionLabel covers every variant", () => {
    expect(actionLabel({ type: "backupNow" })).toBe("Back up");
    expect(actionLabel({ type: "switchover", to: "x" })).toBe("Switch over");
    expect(actionLabel({ type: "hibernate", on: true })).toBe("Hibernate");
    expect(actionLabel({ type: "hibernate", on: false })).toBe("Resume");
    expect(actionLabel({ type: "scale", current: 1, desired: 2 })).toBe("Scale");
    expect(actionLabel({ type: "portForward" })).toBe("Port-forward");
    expect(actionLabel({ type: "revealCredentials" })).toBe("Credentials");
    expect(actionLabel({ type: "copyDSN" })).toBe("Copy DSN");
  });

  const inst = cnpgInstance();

  test("backup → command, non-destructive", () => {
    expect(actionToBlock({ type: "backupNow" }, inst)).toEqual({
      kind: "command",
      label: "Back up pg",
      args: ["cnpg", "backup", "pg", "-n", "default"],
      destructive: false,
    });
  });

  test("switchover → command, destructive", () => {
    expect(actionToBlock({ type: "switchover", to: "pg-2" }, inst)).toEqual({
      kind: "command",
      label: "Switch over pg → pg-2",
      args: ["cnpg", "promote", "pg", "pg-2", "-n", "default"],
      destructive: true,
    });
  });

  test("switchover with empty target → null", () => {
    expect(actionToBlock({ type: "switchover", to: "" }, inst)).toBeNull();
  });

  test("hibernate on → command, destructive", () => {
    expect(actionToBlock({ type: "hibernate", on: true }, inst)).toEqual({
      kind: "command",
      label: "Hibernate pg",
      args: ["cnpg", "hibernate", "on", "pg", "-n", "default"],
      destructive: true,
    });
  });

  test("resume (hibernate off) → command, non-destructive", () => {
    expect(actionToBlock({ type: "hibernate", on: false }, inst)).toEqual({
      kind: "command",
      label: "Resume pg",
      args: ["cnpg", "hibernate", "off", "pg", "-n", "default"],
      destructive: false,
    });
  });

  test("scale CNPG → patch command; destructive only when scaling down", () => {
    expect(actionToBlock({ type: "scale", current: 3, desired: 5 }, inst)).toEqual({
      kind: "command",
      label: "Scale pg → 5",
      args: ["patch", "cluster", "pg", "-n", "default", "--type=merge", "-p", '{"spec":{"instances":5}}'],
      destructive: false,
    });
    expect(actionToBlock({ type: "scale", current: 3, desired: 1 }, inst)?.destructive).toBe(true);
  });

  test("scale deployment → scale block targets deployment", () => {
    expect(actionToBlock({ type: "scale", current: 1, desired: 2 }, imgInstance())).toEqual({
      kind: "scale",
      name: "my-redis",
      namespace: "default",
      resourceKind: "deployment",
      replicas: 2,
    });
  });

  test("scale statefulset → scale block targets statefulset (not deployment)", () => {
    expect(
      actionToBlock({ type: "scale", current: 1, desired: 2 }, imgInstance({ source: "statefulset" })),
    ).toEqual({
      kind: "scale",
      name: "my-redis",
      namespace: "default",
      resourceKind: "statefulset",
      replicas: 2,
    });
  });

  test("non-mutating actions → null", () => {
    expect(actionToBlock({ type: "portForward" }, inst)).toBeNull();
    expect(actionToBlock({ type: "revealCredentials" }, inst)).toBeNull();
    expect(actionToBlock({ type: "copyDSN" }, inst)).toBeNull();
  });
});
