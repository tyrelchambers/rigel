import { describe, expect, it } from "vitest";
import { planData } from "./dataPlans";

const cluster = {
  kind: "Cluster",
  metadata: { name: "postgres", namespace: "default" },
  spec: { plugins: [{ name: "barman-cloud.cloudnative-pg.io", parameters: { barmanObjectName: "postgres-garage" } }] },
};

const garage = {
  kind: "ObjectStore",
  metadata: { name: "postgres-garage", namespace: "default" },
  spec: { configuration: { endpointURL: "http://garage-s3.default.svc.cluster.local:3900" } },
};

const spaces = {
  kind: "ObjectStore",
  metadata: { name: "postgres-spaces", namespace: "default" },
  spec: { configuration: { endpointURL: "https://tor1.digitaloceanspaces.com" } },
};

describe("planData", () => {
  it("blocks in-cluster barman until pg_dump is accepted", () => {
    const out = planData({
      closure: [{ kind: "Cluster", namespace: "default", name: "postgres" }],
      clusters: [cluster],
      objectStores: [garage],
      pvcs: [],
    });
    expect(out.plans).toEqual([]);
    expect(out.blockers[0]?.rule).toBe("backupTargetIsInsideSourceCluster");
  });

  it("uses pg_dump only after that rewrite is accepted", () => {
    const out = planData({
      closure: [{ kind: "Cluster", namespace: "default", name: "postgres" }],
      clusters: [cluster],
      objectStores: [garage],
      pvcs: [],
      acceptedRewrites: [{ rule: "backupTargetIsInsideSourceCluster", to: "pgDump" }],
    });
    expect(out.blockers).toEqual([]);
    expect(out.plans).toEqual([
      expect.objectContaining({ kind: "pgDump", subject: { kind: "Cluster", namespace: "default", name: "postgres" } }),
    ]);
  });

  it("uses barman when the ObjectStore is off-site", () => {
    const offsite = {
      ...cluster,
      spec: { plugins: [{ name: "barman-cloud.cloudnative-pg.io", parameters: { barmanObjectName: "postgres-spaces" } }] },
    };
    const out = planData({
      closure: [{ kind: "Cluster", namespace: "default", name: "postgres" }],
      clusters: [offsite],
      objectStores: [spaces],
      pvcs: [],
    });
    expect(out.plans[0]?.kind).toBe("cnpgBarman");
  });

  it("starts redis empty and tars other PVCs", () => {
    const out = planData({
      closure: [
        { kind: "PersistentVolumeClaim", namespace: "default", name: "redis-data" },
        { kind: "PersistentVolumeClaim", namespace: "default", name: "uploads" },
      ],
      clusters: [],
      objectStores: [],
      pvcs: [
        { metadata: { name: "redis-data", namespace: "default" }, spec: { resources: { requests: { storage: "1Gi" } } } },
        { metadata: { name: "uploads", namespace: "default" }, spec: { resources: { requests: { storage: "534Mi" } } }, status: { capacity: { storage: "534Mi" } } },
      ],
    });
    expect(out.plans.find((p) => p.subject.name === "redis-data")?.kind).toBe("startEmpty");
    expect(out.plans.find((p) => p.subject.name === "uploads")?.kind).toBe("pvcTar");
  });
});
