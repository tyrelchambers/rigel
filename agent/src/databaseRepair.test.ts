import { describe, expect, test } from "vitest";
import { planDatabaseRepair, REPAIR_GRACE_MS } from "./databaseRepair.js";
import { detectDatabaseClusters, type Incident } from "./detector.js";

const cluster = (readinessType?: string, failoverDelay = 300) => ({
  metadata: { name: "postgres", namespace: "default" },
  spec: { instances: 3, failoverDelay, probes: readinessType ? { readiness: { type: readinessType } } : undefined },
  status: { currentPrimary: "postgres-25", phase: "Cluster in healthy state" },
});

const pod = (name: string, ready: boolean) => ({
  metadata: { name, namespace: "default", labels: { "cnpg.io/cluster": "postgres", "cnpg.io/instanceName": name } },
  status: { conditions: [{ type: "Ready", status: ready ? "True" : "False" }] },
});

const noPrimary: Incident = { incidentKind: "databaseNotReady", namespace: "default", name: "postgres", reason: "NoPrimary", detail: "" };

describe("detectDatabaseClusters", () => {
  test("flags a missing primary even when the operator still reports healthy", () => {
    const out = detectDatabaseClusters({ items: [cluster("streaming")] }, { items: [pod("postgres-24", false), pod("postgres-26", true)] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ incidentKind: "databaseNotReady", name: "postgres", reason: "NoPrimary" });
    expect(out[0]!.detail).toContain("missing");
  });

  test("flags a degraded cluster whose primary is fine", () => {
    const out = detectDatabaseClusters({ items: [cluster()] }, { items: [pod("postgres-25", true), pod("postgres-26", true), pod("postgres-24", false)] });
    expect(out).toEqual([expect.objectContaining({ reason: "Degraded", detail: "2/3 instances ready" })]);
  });

  test("ignores pooler pods and reports nothing for a healthy cluster", () => {
    const pooler = { metadata: { name: "postgres-pooler-x", namespace: "default", labels: { "cnpg.io/cluster": "postgres", "cnpg.io/poolerName": "postgres-pooler" } }, status: { conditions: [{ type: "Ready", status: "False" }] } };
    const out = detectDatabaseClusters({ items: [cluster()] }, { items: [pod("postgres-24", true), pod("postgres-25", true), pod("postgres-26", true), pooler] });
    expect(out).toEqual([]);
  });

  test("a terminating primary is not ready", () => {
    const terminating = { ...pod("postgres-25", true), metadata: { ...pod("postgres-25", true).metadata, deletionTimestamp: "2026-11-06T22:04:00Z" } };
    const out = detectDatabaseClusters({ items: [cluster()] }, { items: [terminating, pod("postgres-24", true), pod("postgres-26", true)] });
    expect(out[0]).toMatchObject({ reason: "NoPrimary" });
  });
});

describe("planDatabaseRepair", () => {
  const t0 = 1_000_000;

  test("waits out failoverDelay plus grace before repairing", () => {
    expect(planDatabaseRepair(noPrimary, [cluster("streaming")], t0, t0 + 300_000)).toEqual({ kind: "wait" });
  });

  test("repairs a streaming-probe deadlock once the operator had its chance", () => {
    const plan = planDatabaseRepair(noPrimary, [cluster("streaming")], t0, t0 + 300_000 + REPAIR_GRACE_MS);
    expect(plan).toMatchObject({ kind: "repair", action: { kind: "repairDatabase", cluster: "postgres", namespace: "default" } });
  });

  test("leaves non-deadlock cases to the worker", () => {
    expect(planDatabaseRepair(noPrimary, [cluster("pg_isready")], t0, t0 + 3_600_000)).toBeNull();
    expect(planDatabaseRepair({ ...noPrimary, reason: "Degraded" }, [cluster("streaming")], t0, t0 + 3_600_000)).toBeNull();
    expect(planDatabaseRepair(noPrimary, [], t0, t0 + 3_600_000)).toBeNull();
  });
});
