import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setClusterConfigIO, __useFakeClusterConfig } from "./clusterConfigStore";
import { writeFailoverPatch } from "./failoverConfig";
import { confirmEdge, planFailover, runFailover, scaleHome } from "./failoverRun";

const CTX = "home";

let prevHome: string | undefined;

beforeEach(async () => {
  __useFakeClusterConfig();
  prevHome = process.env.HOME;
  process.env.HOME = await mkdtemp(join(tmpdir(), "rigel-failover-run-"));
});

afterEach(() => {
  __setClusterConfigIO(null);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
});

const garageCluster = {
  kind: "Cluster",
  metadata: { name: "postgres", namespace: "default" },
  spec: { plugins: [{ name: "barman-cloud.cloudnative-pg.io", parameters: { barmanObjectName: "postgres-garage" } }] },
};
const garageStore = {
  kind: "ObjectStore",
  metadata: { name: "postgres-garage", namespace: "default" },
  spec: { configuration: { endpointURL: "http://garage-s3.default.svc.cluster.local:3900" } },
};

function getJson(_ctx: string | null, args: string[]): Promise<unknown> {
  const kind = args[1];
  if (kind === "clusters.postgresql.cnpg.io") return Promise.resolve({ items: [garageCluster] });
  if (kind === "objectstores.barmancloud.cnpg.io") return Promise.resolve({ items: [garageStore] });
  if (kind === "deployments") {
    return Promise.resolve({
      items: [
        {
          kind: "Deployment",
          metadata: { name: "reddex-deploy", namespace: "default" },
          spec: { selector: { matchLabels: { app: "reddex" } }, template: { spec: { containers: [{ image: "reddex:1" }] } } },
        },
      ],
    });
  }
  return Promise.resolve({ items: [] });
}

describe("planFailover", () => {
  it("blocks in-cluster barman until pg_dump is accepted", async () => {
    const plan = await planFailover(CTX, { kind: "namespace", namespace: "default" }, [], 1, getJson);
    expect(plan.blockers.some((b) => b.rule === "backupTargetIsInsideSourceCluster")).toBe(true);
  });

  it("clears that blocker once pg_dump is accepted", async () => {
    const plan = await planFailover(
      CTX,
      { kind: "namespace", namespace: "default" },
      [{ rule: "backupTargetIsInsideSourceCluster", to: "pgDump" }],
      1,
      getJson,
    );
    expect(plan.blockers.filter((b) => b.rule === "backupTargetIsInsideSourceCluster")).toEqual([]);
    expect(plan.plans.some((p) => p.kind === "pgDump")).toBe(true);
  });
});

describe("runFailover", () => {
  it("does not provision when blockers remain", async () => {
    await writeFailoverPatch(CTX, { token: "t", spacesKey: "k", spacesSecret: "s", nodeCount: 1 });
    let provisioned = false;
    await expect(
      runFailover(CTX, { kind: "namespace", namespace: "default" }, [], {
        get: getJson,
        provision: async () => {
          provisioned = true;
          return { id: "x", name: "n", context: "do-tor1-n" };
        },
      }),
    ).rejects.toThrow(/blocked/);
    expect(provisioned).toBe(false);
  });
});

describe("scaleHome", () => {
  it("rejects until the edge cutover is confirmed", async () => {
    await writeFailoverPatch(CTX, { token: "t", spacesKey: "k", spacesSecret: "s" });
    const { writeUserConfig } = await import("./clusterConfigStore");
    const { FAILOVER_STATE_KEY } = await import("@rigel/k8s/src/userConfig");
    await writeUserConfig(CTX, () => ({
      [FAILOVER_STATE_KEY]: JSON.stringify({
        failedOverTo: {
          context: "do-tor1-x",
          at: "2026-09-02T18:00:00.000Z",
          batchId: "b",
          scaledToZero: [{ kind: "Deployment", namespace: "default", name: "reddex-deploy", replicas: 3 }],
          edgeConfirmed: false,
        },
      }),
    }));
    await expect(scaleHome(CTX)).rejects.toThrow(/Confirm the edge cutover/);
    await confirmEdge(CTX);
    const scaled: string[][] = [];
    await scaleHome(CTX, async (_ctx, args) => {
      scaled.push(args);
      return { code: 0, stdout: "", stderr: "" };
    });
    expect(scaled.some((a) => a[0] === "scale")).toBe(true);
  });
});
