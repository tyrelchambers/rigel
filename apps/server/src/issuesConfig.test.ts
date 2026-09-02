import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setClusterConfigIO, __useFakeClusterConfig } from "./clusterConfigStore";
import { readIssueMutes, writeIssueMutes } from "./issuesConfig";

const CTX = "test-cluster";

let prevHome: string | undefined;

beforeEach(async () => {
  __useFakeClusterConfig();
  prevHome = process.env.HOME;
  process.env.HOME = await mkdtemp(join(tmpdir(), "rigel-issues-test-"));
});

afterEach(() => {
  __setClusterConfigIO(null);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
});

describe("issuesConfig", () => {
  it("returns an empty map when nothing is stored", async () => {
    expect(await readIssueMutes(CTX)).toEqual({});
  });

  it("round-trips a mute through the cluster Secret", async () => {
    await writeIssueMutes(CTX, { "crashLoopBackOff|Pod|default|api-0|x": { until: null } });
    expect(await readIssueMutes(CTX)).toEqual({ "crashLoopBackOff|Pod|default|api-0|x": { until: null } });
  });

  it("replaces the stored map wholesale", async () => {
    await writeIssueMutes(CTX, { a: { until: null } });
    await writeIssueMutes(CTX, { b: { until: null } });
    expect(await readIssueMutes(CTX)).toEqual({ b: { until: null } });
  });

  it("keeps mutes for one context out of another", async () => {
    await writeIssueMutes(CTX, { a: { until: null } });
    expect(await readIssueMutes("other-cluster")).toEqual({});
  });
});
