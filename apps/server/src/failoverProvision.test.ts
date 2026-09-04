import { describe, expect, it } from "vitest";
import type { FailoverDestination } from "@rigel/k8s/src/failover/destination";
import { createClusterArgs, failoverClusterName, provisionDoks, type Run } from "./failoverProvision";

const dest: FailoverDestination = {
  provider: "digitalocean",
  token: "dop_v1_abc",
  region: "tor1",
  nodeSize: "s-4vcpu-8gb",
  nodeCount: 1,
};

describe("createClusterArgs", () => {
  it("passes region, size, count and waits", () => {
    expect(createClusterArgs(dest, "rigel-failover-20260902-1800")).toEqual([
      "kubernetes",
      "cluster",
      "create",
      "rigel-failover-20260902-1800",
      "--region",
      "tor1",
      "--size",
      "s-4vcpu-8gb",
      "--count",
      "1",
      "--wait",
      "-o",
      "json",
    ]);
  });
});

describe("provisionDoks", () => {
  it("creates, then saves kubeconfig, and names the context do-region-name", async () => {
    const calls: string[][] = [];
    const run: Run = async (bin, args) => {
      expect(bin).toBe("doctl");
      calls.push(args);
      if (args[2] === "create") {
        return { code: 0, stdout: JSON.stringify({ id: "abc", name: args[3] }), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const clock = () => new Date("2026-09-02T18:00:00.000Z");
    const out = await provisionDoks(dest, { run, clock });
    expect(out.id).toBe("abc");
    expect(out.name).toBe(failoverClusterName(clock()));
    expect(out.context).toBe(`do-tor1-${out.name}`);
    expect(calls[0]?.[2]).toBe("create");
    expect(calls[1]).toEqual(["kubernetes", "cluster", "kubeconfig", "save", "abc"]);
  });
});
