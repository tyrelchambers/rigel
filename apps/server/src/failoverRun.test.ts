import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setClusterConfigIO, __useFakeClusterConfig } from "./clusterConfigStore";
import { writeFailoverPatch } from "./failoverConfig";
import { confirmEdge, planFailover, restoreHome, runFailover, scaleHome } from "./failoverRun";

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

const poolerSecret = {
  metadata: { name: "reddex-env", namespace: "default" },
  data: {
    DATABASE_URL: Buffer.from("postgres://a:b@postgres-pooler.default:5432/reddex").toString("base64"),
  },
};
const poolerService = {
  metadata: { name: "postgres-pooler", namespace: "default", labels: { "cnpg.io/cluster": "postgres" } },
  spec: { type: "ClusterIP", selector: { "cnpg.io/poolerName": "postgres-pooler" }, ports: [{ port: 5432 }] },
};

function getJson(_ctx: string | null, args: string[]): Promise<unknown> {
  const kind = args[1];
  if (kind === "secrets") return Promise.resolve({ items: [poolerSecret] });
  if (kind === "services") return Promise.resolve({ items: [poolerService] });
  if (kind === "clusters.postgresql.cnpg.io") return Promise.resolve({ items: [garageCluster] });
  if (kind === "objectstores.barmancloud.cnpg.io") return Promise.resolve({ items: [garageStore] });
  if (kind === "deployments") {
    return Promise.resolve({
      items: [
        {
          kind: "Deployment",
          metadata: { name: "reddex-deploy", namespace: "default" },
          spec: {
            selector: { matchLabels: { app: "reddex" } },
            template: {
              spec: { containers: [{ image: "reddex:1", envFrom: [{ secretRef: { name: "reddex-env" } }] }] },
            },
          },
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
    expect(plan.members.some((m) => m.kind === "Cluster" && m.name === "postgres")).toBe(true);
  });
});

describe("planFailover endpoint rewrites", () => {
  const accepted = [{ rule: "backupTargetIsInsideSourceCluster", to: "pgDump" }];

  it("repoints a pooler URL held in a Secret the closure carries", async () => {
    const plan = await planFailover(CTX, { kind: "namespace", namespace: "default" }, accepted, 1, getJson);
    expect(plan.endpointRewrites).toEqual([
      expect.objectContaining({
        key: "DATABASE_URL",
        to: "postgres://a:b@postgres-rw.default.svc.cluster.local:5432/reddex",
        via: "postgres-pooler",
      }),
    ]);
  });

  it("ignores Secrets that are not in the closure", async () => {
    const strayOnly = (ctx: string | null, args: string[]) =>
      args[1] === "deployments" ? Promise.resolve({ items: [] }) : getJson(ctx, args);
    const plan = await planFailover(CTX, { kind: "namespace", namespace: "default" }, accepted, 1, strayOnly);
    expect(plan.endpointRewrites).toEqual([]);
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

  it("copies planned data after apply and keeps dump bytes out of the result", async () => {
    await writeFailoverPatch(CTX, { token: "t", spacesKey: "k", spacesSecret: "s", nodeCount: 1 });
    let copiedFrom: string | null | undefined;
    let copiedTo: string | null | undefined;
    const result = await runFailover(
      CTX,
      { kind: "namespace", namespace: "default" },
      [{ rule: "backupTargetIsInsideSourceCluster", to: "pgDump" }],
      {
        get: getJson,
        provision: async () => ({ id: "x", name: "n", context: "do-tor1-n" }),
        stack: async () => undefined,
        apply: async () => ({ code: 0, stdout: "", stderr: "", batchId: "b" }),
        copyData: async (opts) => {
          copiedFrom = opts.fromContext;
          copiedTo = opts.toContext;
          return {
            steps: [
              {
                kind: "pgDump",
                subject: { kind: "Cluster", namespace: "default", name: "postgres" },
                action: "copied",
                artifacts: ["globals.sql", "reddex.dump"],
              },
            ],
          };
        },
      },
    );
    expect(copiedFrom).toBe(CTX);
    expect(copiedTo).toBe("do-tor1-n");
    expect(result.data.steps[0]?.artifacts).toEqual(["globals.sql", "reddex.dump"]);
    expect(JSON.stringify(result)).not.toContain("CREATE ROLE");
    expect(JSON.stringify(result)).not.toContain("PGDUMP-BINARY");
    const { readUserConfig } = await import("./clusterConfigStore");
    const { FAILOVER_STATE_KEY } = await import("@rigel/k8s/src/userConfig");
    const state = JSON.parse((await readUserConfig(CTX)).data[FAILOVER_STATE_KEY] ?? "{}") as {
      failedOverTo?: { dataPlans?: Array<{ kind: string }> };
    };
    expect(state.failedOverTo?.dataPlans?.some((p) => p.kind === "pgDump")).toBe(true);
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

describe("restoreHome", () => {
  const stateBlob = {
    failedOverTo: {
      context: "do-tor1-x",
      clusterId: "abc",
      at: "2026-09-02T18:00:00.000Z",
      batchId: "b",
      scaledToZero: [{ kind: "Deployment", namespace: "default", name: "reddex-deploy", replicas: 3 }],
      edgeConfirmed: true,
      dataPlans: [{ subject: { kind: "Cluster", namespace: "default", name: "postgres" }, kind: "pgDump" }],
    },
  };

  async function seed() {
    await writeFailoverPatch(CTX, { token: "t", spacesKey: "k", spacesSecret: "s" });
    const { writeUserConfig } = await import("./clusterConfigStore");
    const { FAILOVER_STATE_KEY } = await import("@rigel/k8s/src/userConfig");
    await writeUserConfig(CTX, () => ({ [FAILOVER_STATE_KEY]: JSON.stringify(stateBlob) }));
  }

  it("refuses a wholesale replace when home wrote after failover", async () => {
    await seed();
    let copied = false;
    const out = await restoreHome(CTX, { localWriteAt: "2026-09-02T19:00:00.000Z" }, {
      copyData: async () => {
        copied = true;
        return { steps: [] };
      },
    });
    expect(out).toEqual({ ok: false, error: "Local writes happened after failover; refusing a wholesale replace" });
    expect(copied).toBe(false);
  });

  it("dumps the remote, restores home, then scales home back", async () => {
    await seed();
    const order: string[] = [];
    const out = await restoreHome(CTX, {}, {
      kubectl: async (ctx, args) => {
        order.push(`${ctx}:${args.join(" ")}`);
        return { code: 0, stdout: "", stderr: "" };
      },
      copyData: async (opts) => {
        order.push(`copy:${opts.fromContext}->${opts.toContext}`);
        expect(opts.plans).toEqual(stateBlob.failedOverTo.dataPlans);
        return {
          steps: [
            {
              kind: "pgDump",
              subject: { kind: "Cluster", namespace: "default", name: "postgres" },
              action: "copied",
              artifacts: ["globals.sql"],
            },
          ],
        };
      },
      destroy: async () => {
        order.push("destroy");
      },
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(JSON.stringify(out.data)).not.toContain("CREATE ROLE");
      expect(JSON.stringify(out.data)).not.toContain("PGDUMP-BINARY");
    }
    expect(order[0]).toBe("do-tor1-x:scale deployment reddex-deploy -n default --replicas=0");
    expect(order[1]).toBe("copy:do-tor1-x->home");
    expect(order[2]).toBe("home:scale deployment reddex-deploy -n default --replicas=3");
    expect(order[3]).toBe("destroy");
  });
});
