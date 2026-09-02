import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setClusterConfigIO, __useFakeClusterConfig } from "./clusterConfigStore";
import { failoverConfigView, writeFailoverPatch } from "./failoverConfig";

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
      spacesKey: "KEY",
      spacesSecret: "SECRET",
      region: "tor1",
      nodeCount: 2,
    });
    expect(view.configured).toBe(true);
    expect(view.tokenSet).toBe(true);
    expect(view.spacesKeySet).toBe(true);
    expect(view.region).toBe("tor1");
    expect(JSON.stringify(view)).not.toContain("dop_v1_abc");
    expect(JSON.stringify(view)).not.toContain("SECRET");
  });

  it("keeps stored secrets when a later patch omits them", async () => {
    await writeFailoverPatch(CTX, {
      token: "dop_v1_abc",
      spacesKey: "KEY",
      spacesSecret: "SECRET",
    });
    const view = await writeFailoverPatch(CTX, { region: "nyc3", nodeCount: 3 });
    expect(view.region).toBe("nyc3");
    expect(view.nodeCount).toBe(3);
    expect(view.tokenSet).toBe(true);
  });

  it("keeps one cluster's destination out of another", async () => {
    await writeFailoverPatch(CTX, {
      token: "dop_v1_abc",
      spacesKey: "KEY",
      spacesSecret: "SECRET",
    });
    expect((await failoverConfigView("other-cluster")).configured).toBe(false);
  });

  it("rejects a first save that is missing the Spaces pair", async () => {
    await expect(writeFailoverPatch(CTX, { token: "dop_v1_abc", region: "tor1" })).rejects.toThrow(
      /token and Spaces key pair are required/,
    );
  });
});
