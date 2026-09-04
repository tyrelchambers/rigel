import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setClusterConfigIO, __useFakeClusterConfig } from "./clusterConfigStore";
import {
  deleteFailoverDestination,
  failoverConfigView,
  validateFailoverPatch,
  writeFailoverPatch,
} from "./failoverConfig";
import { FAILOVER_STATE_KEY } from "@rigel/k8s/src/userConfig";
import { writeUserConfig } from "./clusterConfigStore";

const CTX = "test-cluster";

let prevHome: string | undefined;

beforeEach(async () => {
  __useFakeClusterConfig();
  prevHome = process.env.HOME;
  process.env.HOME = await mkdtemp(join(tmpdir(), "rigel-failover-test-"));
});

afterEach(() => {
  __setClusterConfigIO(null);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
});

describe("failoverConfig", () => {
  it("returns an unconfigured view when nothing is stored", async () => {
    const view = await failoverConfigView(CTX);
    expect(view.configured).toBe(false);
    expect(view.tokenSet).toBe(false);
    expect(view.region).toBe("tor1");
    expect(JSON.stringify(view)).not.toMatch(/dop_v1_|SECRET/);
  });

  it("round-trips a destination and never returns secret values", async () => {
    const view = await writeFailoverPatch(CTX, {
      token: "dop_v1_abc",
      region: "tor1",
      nodeCount: 2,
    }, { validateApi: async () => ({ api: { ok: true as const, email: "me@example.com" } }) });
    expect(view.configured).toBe(true);
    expect(view.tokenSet).toBe(true);
    expect(view.tokenSet).toBe(true);
    expect(view.region).toBe("tor1");
    expect(JSON.stringify(view)).not.toContain("dop_v1_abc");
    expect(JSON.stringify(view)).not.toContain("SECRET");
  });

  it("keeps stored secrets when a later patch omits them", async () => {
    await writeFailoverPatch(CTX, {
      token: "dop_v1_abc",
    }, { validateApi: async () => ({ api: { ok: true as const, email: "me@example.com" } }) });
    const view = await writeFailoverPatch(CTX, { region: "nyc3", nodeCount: 3 }, { validateApi: async () => ({ api: { ok: true as const, email: "me@example.com" } }) });
    expect(view.region).toBe("nyc3");
    expect(view.nodeCount).toBe(3);
    expect(view.tokenSet).toBe(true);
  });

  it("keeps one cluster's destination out of another", async () => {
    await writeFailoverPatch(CTX, {
      token: "dop_v1_abc",
    }, { validateApi: async () => ({ api: { ok: true as const, email: "me@example.com" } }) });
    expect((await failoverConfigView("other-cluster")).configured).toBe(false);
  });

  it("saves with a token alone, because the object store is optional", async () => {
    const view = await writeFailoverPatch(CTX, { token: "dop_v1_abc", region: "tor1" }, { validateApi: async () => ({ api: { ok: true as const, email: "me@example.com" } }) });
    expect(view).toMatchObject({ configured: true, tokenSet: true, region: "tor1" });
    expect(view.objectStore).toBeUndefined();
  });

  it("rejects a first save with no token at all", async () => {
    await expect(writeFailoverPatch(CTX, { region: "tor1" }, { validateApi: async () => ({ api: { ok: true as const, email: "me@example.com" } }) })).rejects.toThrow(/required/);
  });
});


const okApi = async () => ({ api: { ok: true as const, email: "me@example.com" } });
const store = {
  endpoint: "https://tor1.digitaloceanspaces.com",
  region: "us-east-1",
  bucket: "rigel-failover",
  accessKey: "KEY",
  secretKey: "SECRET",
  addressing: "virtualHost" as const,
};

describe("validateFailoverPatch", () => {
  it("answers inline rather than throwing when there is no token yet", async () => {
    const out = await validateFailoverPatch(CTX, {}, { validateApi: okApi });
    expect(out).toEqual({ ok: false, api: { ok: false, error: "DigitalOcean token is required" } });
  });

  it("validates the patch merged onto what is stored, so an untouched token still counts", async () => {
    await writeFailoverPatch(CTX, { token: "dop_v1_abc" }, { validateApi: okApi });
    let seen = "";
    const out = await validateFailoverPatch(CTX, { region: "nyc3" }, {
      validateApi: async (d) => {
        seen = d.token;
        return { api: { ok: true as const, email: "me@example.com" } };
      },
    });
    expect(seen).toBe("dop_v1_abc");
    expect(out.ok).toBe(true);
  });

  it("checks the object store only when one is configured", async () => {
    await writeFailoverPatch(CTX, { token: "t" }, { validateApi: okApi });
    const never = async () => { throw new Error("should not be called"); };
    expect((await validateFailoverPatch(CTX, {}, { validateApi: okApi, validateStore: never })).objectStore)
      .toBeUndefined();
  });

  it("fails overall when the store is rejected even though the token is good", async () => {
    const out = await validateFailoverPatch(CTX, { token: "t", objectStore: store }, {
      validateApi: okApi,
      validateStore: async () => ({ ok: false as const, code: "addressing", error: "wrong style" }),
    });
    expect(out.ok).toBe(false);
    expect(out.api.ok).toBe(true);
  });
});

describe("writeFailoverPatch validation", () => {
  it("refuses to store a token the provider rejected", async () => {
    await expect(
      writeFailoverPatch(CTX, { token: "bad" }, {
        validateApi: async () => ({ api: { ok: false as const, status: 401, error: "DigitalOcean rejected this token." } }),
      }),
    ).rejects.toThrow(/rejected this token/);
    expect((await failoverConfigView(CTX)).configured).toBe(false);
  });

  it("does not call out to anything for a patch that only moves the cluster shape", async () => {
    await writeFailoverPatch(CTX, { token: "t" }, { validateApi: okApi });
    const never = async () => { throw new Error("should not be called"); };
    const view = await writeFailoverPatch(CTX, { nodeCount: 3 }, { validateApi: never });
    expect(view.nodeCount).toBe(3);
  });

  it("creates a bucket that does not exist yet, before storing the destination", async () => {
    const order: string[] = [];
    const view = await writeFailoverPatch(CTX, { token: "t", objectStore: store }, {
      validateApi: okApi,
      validateStore: async () => ({ ok: true as const, bucketExists: false, insideSourceCluster: false }),
      createBucket: async () => { order.push("created"); },
    });
    expect(order).toEqual(["created"]);
    expect(view.objectStore?.bucket).toBe("rigel-failover");
  });

  it("does not create a bucket that is already there", async () => {
    let created = false;
    await writeFailoverPatch(CTX, { token: "t", objectStore: store }, {
      validateApi: okApi,
      validateStore: async () => ({ ok: true as const, bucketExists: true, insideSourceCluster: false }),
      createBucket: async () => { created = true; },
    });
    expect(created).toBe(false);
  });
});

describe("deleteFailoverDestination", () => {
  it("clears a destination that nothing is using", async () => {
    await writeFailoverPatch(CTX, { token: "t" }, { validateApi: okApi });
    expect((await deleteFailoverDestination(CTX)).configured).toBe(false);
  });

  it("refuses while a failover is active, because the token is what destroys the cluster", async () => {
    await writeFailoverPatch(CTX, { token: "t" }, { validateApi: okApi });
    await writeUserConfig(CTX, () => ({
      [FAILOVER_STATE_KEY]: JSON.stringify({
        failedOverTo: { context: "do-x", at: "now", batchId: "b", scaledToZero: [], edgeConfirmed: false },
      }),
    }));
    await expect(deleteFailoverDestination(CTX)).rejects.toThrow(/still using this destination/);
    expect((await failoverConfigView(CTX)).configured).toBe(true);
  });

  it("refuses while a cluster was left behind", async () => {
    await writeFailoverPatch(CTX, { token: "t" }, { validateApi: okApi });
    await writeUserConfig(CTX, () => ({
      [FAILOVER_STATE_KEY]: JSON.stringify({
        leftBehind: { clusterId: "abc", context: "do-x", at: "now", error: "boom" },
      }),
    }));
    await expect(deleteFailoverDestination(CTX)).rejects.toThrow(/left behind/);
  });
});
