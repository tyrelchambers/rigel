import { describe, expect, it } from "vitest";
import {
  DEFAULT_FAILOVER_NODE_COUNT,
  DEFAULT_FAILOVER_NODE_SIZE,
  DEFAULT_FAILOVER_REGION,
  applyFailoverPatch,
  maskFailoverDestination,
  parseFailoverDestination,
  serializeFailoverDestination,
} from "./destination";
import type { FailoverDestination } from "./types";

const valid: FailoverDestination = {
  provider: "digitalocean",
  token: "dop_v1_abc",
  spacesKey: "KEY",
  spacesSecret: "SECRET",
  region: "tor1",
  nodeSize: "s-4vcpu-8gb",
  nodeCount: 2,
};

describe("parseFailoverDestination", () => {
  it("reads a blank blob as not configured", () => {
    expect(parseFailoverDestination("")).toBeNull();
    expect(parseFailoverDestination("   ")).toBeNull();
  });

  it("reads unreadable JSON as not configured rather than throwing", () => {
    expect(parseFailoverDestination("not json")).toBeNull();
    expect(parseFailoverDestination("[]")).toBeNull();
    expect(parseFailoverDestination("null")).toBeNull();
  });

  it("rejects an unknown provider and a missing token", () => {
    expect(parseFailoverDestination(JSON.stringify({ ...valid, provider: "aws" }))).toBeNull();
    expect(parseFailoverDestination(JSON.stringify({ ...valid, token: "" }))).toBeNull();
    expect(parseFailoverDestination(JSON.stringify({ ...valid, spacesKey: "  " }))).toBeNull();
  });

  it("round-trips a complete destination", () => {
    expect(parseFailoverDestination(serializeFailoverDestination(valid))).toEqual(valid);
  });

  it("fills region, size and count from the documented defaults", () => {
    const parsed = parseFailoverDestination(
      JSON.stringify({
        provider: "digitalocean",
        token: "t",
        spacesKey: "k",
        spacesSecret: "s",
      }),
    );
    expect(parsed).toEqual({
      provider: "digitalocean",
      token: "t",
      spacesKey: "k",
      spacesSecret: "s",
      region: DEFAULT_FAILOVER_REGION,
      nodeSize: DEFAULT_FAILOVER_NODE_SIZE,
      nodeCount: DEFAULT_FAILOVER_NODE_COUNT,
    });
  });

  it("keeps a last selection of workloads", () => {
    const withSel = {
      ...valid,
      lastSelection: {
        kind: "workloads" as const,
        items: [{ kind: "Deployment", namespace: "default", name: "reddex-deploy" }],
      },
    };
    expect(parseFailoverDestination(serializeFailoverDestination(withSel))).toEqual(withSel);
  });
});

describe("maskFailoverDestination", () => {
  it("never includes secret values", () => {
    const view = maskFailoverDestination(valid);
    expect(view).toEqual({
      configured: true,
      provider: "digitalocean",
      tokenSet: true,
      spacesKeySet: true,
      spacesSecretSet: true,
      region: "tor1",
      nodeSize: "s-4vcpu-8gb",
      nodeCount: 2,
    });
    expect(JSON.stringify(view)).not.toContain("dop_v1_abc");
    expect(JSON.stringify(view)).not.toContain("SECRET");
  });

  it("exposes the form defaults when nothing is stored", () => {
    expect(maskFailoverDestination(null)).toMatchObject({
      configured: false,
      tokenSet: false,
      region: DEFAULT_FAILOVER_REGION,
      nodeCount: DEFAULT_FAILOVER_NODE_COUNT,
    });
  });
});

describe("applyFailoverPatch", () => {
  it("cannot create a destination without all three secrets", () => {
    expect(applyFailoverPatch(null, { token: "t", region: "tor1" })).toBeNull();
    expect(applyFailoverPatch(null, { token: "t", spacesKey: "k", spacesSecret: "s" })).toMatchObject({
      token: "t",
      region: DEFAULT_FAILOVER_REGION,
    });
  });

  it("keeps stored secrets when the patch omits them", () => {
    expect(applyFailoverPatch(valid, { region: "nyc3", nodeCount: 3 })).toEqual({
      ...valid,
      region: "nyc3",
      nodeCount: 3,
    });
  });
});
