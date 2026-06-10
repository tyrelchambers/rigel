import { describe, expect, test } from "vitest";
import type {
  CNPGCluster,
  CNPGScheduledBackup,
  DatabaseInstance,
  DatabasePodRaw,
  WorkloadDB,
} from "./types";
import {
  buildInstances,
  compareInstances,
  connectionString,
  detectKindFromImage,
  instanceFromCNPG,
  instanceFromWorkload,
  matchPods,
  matchesDatabase,
  podNodes,
  readyColorClass,
  relativeAge,
  sortInstances,
  sourceBadgeLabel,
  walArchivingStatus,
} from "./databasesDisplay";

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
