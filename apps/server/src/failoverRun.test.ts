import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setClusterConfigIO, __useFakeClusterConfig } from "./clusterConfigStore";
import { writeFailoverPatch } from "./failoverConfig";
import {
  confirmEdge,
  slug,
  stamp,
  planFailover,
  readFailoverLiveState,
  restoreHome,
  runFailover,
  scaleHome,
  teardownLeftBehind,
} from "./failoverRun";

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
    await writeFailoverPatch(CTX, { token: "t", nodeCount: 1 }, { validateApi: async () => ({ api: { ok: true as const, email: "me@example.com" } }) });
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
    await writeFailoverPatch(CTX, { token: "t", nodeCount: 1 }, { validateApi: async () => ({ api: { ok: true as const, email: "me@example.com" } }) });
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
    await writeFailoverPatch(CTX, { token: "t", }, { validateApi: async () => ({ api: { ok: true as const, email: "me@example.com" } }) });
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
    await writeFailoverPatch(CTX, { token: "t", }, { validateApi: async () => ({ api: { ok: true as const, email: "me@example.com" } }) });
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


describe("restoreHome teardown", () => {
  const state = {
    failedOverTo: {
      context: "do-tor1-x",
      clusterId: "abc-123",
      at: "2026-09-03T00:00:00.000Z",
      batchId: "b1",
      scaledToZero: [{ kind: "Deployment", namespace: "default", name: "reddex-deploy", replicas: 2 }],
      edgeConfirmed: true,
      dataPlans: [],
    },
  };

  async function seed() {
    await writeFailoverPatch(CTX, { token: "t", nodeCount: 1 }, { validateApi: async () => ({ api: { ok: true as const, email: "me@example.com" } }) });
    const { writeUserConfig } = await import("./clusterConfigStore");
    const { FAILOVER_STATE_KEY } = await import("@rigel/k8s/src/userConfig");
    await writeUserConfig(CTX, () => ({ [FAILOVER_STATE_KEY]: JSON.stringify(state) }));
  }

  it("reports each restore step", async () => {
    await seed();
    const steps: string[] = [];
    const out = await restoreHome(CTX, {}, {
      kubectl: async () => ({ code: 0, stdout: "", stderr: "" }),
      copyData: async () => ({ steps: [] }),
      destroy: async () => undefined,
      report: (s) => steps.push(`${s.id}:${s.status}`),
    });
    expect(out.ok).toBe(true);
    expect(steps).toContain("scaleRemote:done");
    expect(steps).toContain("scaleHome:done");
    expect(steps).toContain("destroy:done");
  });

  it("still restores when the teardown fails, and remembers the cluster", async () => {
    await seed();
    const out = await restoreHome(CTX, {}, {
      kubectl: async () => ({ code: 0, stdout: "", stderr: "" }),
      copyData: async () => ({ steps: [] }),
      destroy: async () => { throw new Error("droplet API refused"); },
    });
    expect(out).toMatchObject({ ok: true, leftBehind: { clusterId: "abc-123", error: "droplet API refused" } });

    const live = await readFailoverLiveState(CTX);
    expect(live.leftBehind?.clusterId).toBe("abc-123");
    expect(live.failedOverTo).toBeUndefined();
  });

  it("clears the state when the teardown works", async () => {
    await seed();
    await restoreHome(CTX, {}, {
      kubectl: async () => ({ code: 0, stdout: "", stderr: "" }),
      copyData: async () => ({ steps: [] }),
      destroy: async () => undefined,
    });
    const live = await readFailoverLiveState(CTX);
    expect(live.leftBehind).toBeUndefined();
    expect(live.failedOverTo).toBeUndefined();
  });
});

describe("teardownLeftBehind", () => {
  it("refuses when nothing was left behind", async () => {
    await writeFailoverPatch(CTX, { token: "t", nodeCount: 1 }, { validateApi: async () => ({ api: { ok: true as const, email: "me@example.com" } }) });
    expect(await teardownLeftBehind(CTX)).toEqual({ ok: false, error: "No cluster is recorded as left behind" });
  });

  it("destroys the remembered cluster and clears the state", async () => {
    await writeFailoverPatch(CTX, { token: "t", nodeCount: 1 }, { validateApi: async () => ({ api: { ok: true as const, email: "me@example.com" } }) });
    const { writeUserConfig } = await import("./clusterConfigStore");
    const { FAILOVER_STATE_KEY } = await import("@rigel/k8s/src/userConfig");
    await writeUserConfig(CTX, () => ({
      [FAILOVER_STATE_KEY]: JSON.stringify({ leftBehind: { clusterId: "abc-123", context: "do-tor1-x", at: "x", error: "boom" } }),
    }));

    let destroyed = "";
    expect(await teardownLeftBehind(CTX, { destroy: async (_d: unknown, id: string) => { destroyed = id; } })).toEqual({ ok: true });
    expect(destroyed).toBe("abc-123");
    expect((await readFailoverLiveState(CTX)).leftBehind).toBeUndefined();
  });

  it("keeps the record when the retry also fails", async () => {
    await writeFailoverPatch(CTX, { token: "t", nodeCount: 1 }, { validateApi: async () => ({ api: { ok: true as const, email: "me@example.com" } }) });
    const { writeUserConfig } = await import("./clusterConfigStore");
    const { FAILOVER_STATE_KEY } = await import("@rigel/k8s/src/userConfig");
    await writeUserConfig(CTX, () => ({
      [FAILOVER_STATE_KEY]: JSON.stringify({ leftBehind: { clusterId: "abc-123", context: "do-tor1-x", at: "x", error: "boom" } }),
    }));
    const out = await teardownLeftBehind(CTX, { destroy: async () => { throw new Error("still refusing"); } });
    expect(out).toEqual({ ok: false, error: "still refusing" });
    expect((await readFailoverLiveState(CTX)).leftBehind?.clusterId).toBe("abc-123");
  });
});


describe("a cluster read that fails", () => {
  const boom = () => Promise.reject(new Error("Unable to connect to the server: dial tcp: i/o timeout"));

  it("makes the plan fail instead of returning an empty closure with no blockers", async () => {
    await expect(
      planFailover(CTX, { kind: "namespace", namespace: "default" }, [], 1, boom),
    ).rejects.toThrow(/i\/o timeout/);
  });

  it("stops a run before it provisions anything", async () => {
    await writeFailoverPatch(CTX, { token: "t" }, { validateApi: async () => ({ api: { ok: true as const, email: "e" } }) });
    let provisioned = false;
    await expect(
      runFailover(CTX, { kind: "namespace", namespace: "default" }, [], {
        get: boom,
        provision: async () => {
          provisioned = true;
          return { id: "x", name: "n", context: "do-x" };
        },
      }),
    ).rejects.toThrow();
    expect(provisioned).toBe(false);
  });
});


describe("a run that dies after provisioning", () => {
  it("records the cluster it left running and names it on the error", async () => {
    await writeFailoverPatch(CTX, { token: "t" }, { validateApi: async () => ({ api: { ok: true as const, email: "e" } }) });
    let err: (Error & { provisioned?: unknown }) | undefined;
    try {
      await runFailover(
        CTX,
        { kind: "namespace", namespace: "default" },
        [{ rule: "backupTargetIsInsideSourceCluster", to: "pgDump" }],
        {
          get: getJson,
          provision: async () => ({ id: "abc-123", name: "n", context: "do-tor1-n" }),
          stack: async () => {
            throw new Error("helm install timed out");
          },
        },
      );
    } catch (e) {
      err = e as Error & { provisioned?: unknown };
    }

    expect(err?.message).toMatch(/helm install timed out/);
    expect(err?.provisioned).toEqual({ clusterId: "abc-123", context: "do-tor1-n" });

    const live = await readFailoverLiveState(CTX);
    expect(live.leftBehind).toMatchObject({ clusterId: "abc-123", error: "helm install timed out" });
  });

  it("records nothing when it fails before a cluster exists", async () => {
    await writeFailoverPatch(CTX, { token: "t" }, { validateApi: async () => ({ api: { ok: true as const, email: "e" } }) });
    await expect(
      runFailover(CTX, { kind: "namespace", namespace: "default" }, [], {
        get: getJson,
        provision: async () => {
          throw new Error("droplet API refused");
        },
      }),
    ).rejects.toThrow();
    expect((await readFailoverLiveState(CTX)).leftBehind).toBeUndefined();
  });
});


describe("the off-site copy", () => {
  const accepted = [{ rule: "backupTargetIsInsideSourceCluster", to: "pgDump" }];
  const store = {
    endpoint: "https://tor1.digitaloceanspaces.com",
    region: "us-east-1",
    bucket: "rigel-failover",
    accessKey: "KEY",
    secretKey: "SECRET",
    addressing: "virtualHost" as const,
  };
  const okValidate = {
    validateApi: async () => ({ api: { ok: true as const, email: "e" } }),
    validateStore: async () => ({ ok: true as const, bucketExists: true, insideSourceCluster: false }),
  };

  function run(extra: Record<string, unknown>) {
    return runFailover(CTX, { kind: "namespace", namespace: "default" }, accepted, {
      get: getJson,
      apply: async () => ({ batchId: "b1" }),
      provision: async () => ({ id: "x", name: "n", context: "do-x" }),
      stack: async () => {},
      copyData: async () => ({ steps: [] }),
      ...extra,
    } as never);
  }

  it("uploads the copy directory when a store is configured", async () => {
    await writeFailoverPatch(CTX, { token: "t", objectStore: store }, okValidate);
    let seen: { prefix: string; dir: string } | undefined;
    const out = await run({
      upload: async (_s: unknown, prefix: string, dir: string) => {
        seen = { prefix, dir };
        return { keys: ["a", "b"], bytes: 2048 };
      },
    });
    expect(seen?.prefix).toMatch(/^rigel-failover\/home\/\d{8}T\d{4}Z$/);
    expect(out.upload).toEqual({ ok: true, keys: 2, bytes: 2048 });
  });

  it("writes the bundle next to the dumps, so the copy restores by hand", async () => {
    await writeFailoverPatch(CTX, { token: "t", objectStore: store }, okValidate);
    let dir = "";
    await run({ upload: async (_s: unknown, _p: string, d: string) => { dir = d; return { keys: [], bytes: 0 }; } });
    const { access } = await import("node:fs/promises");
    const { join } = await import("node:path");
    // Written before the upload, so whatever the closure exported travels with it.
    await expect(access(join(dir, "bundle.yaml"))).resolves.toBeUndefined();
  });

  it("does not upload when no store is configured", async () => {
    await writeFailoverPatch(CTX, { token: "t" }, okValidate);
    let called = false;
    const out = await run({ upload: async () => { called = true; return { keys: [], bytes: 0 }; } });
    expect(called).toBe(false);
    expect(out.upload).toBeUndefined();
  });

  it("keeps the failover when the upload fails, because the data is already on the target", async () => {
    await writeFailoverPatch(CTX, { token: "t", objectStore: store }, okValidate);
    const out = await run({
      upload: async () => { throw new Error("Spaces refused the key"); },
    });
    expect(out.upload).toEqual({ ok: false, error: "Spaces refused the key" });
    expect(out.context).toBe("do-x");
  });
});

describe("slug and stamp", () => {
  it("makes a context name safe to put in a key", () => {
    expect(slug("do-tor1/rigel failover")).toBe("do-tor1-rigel-failover");
    expect(slug("///")).toBe("cluster");
  });

  it("stamps to the minute in UTC", () => {
    expect(stamp(new Date("2026-09-04T15:30:12Z"))).toBe("20260904T1530Z");
  });
});
