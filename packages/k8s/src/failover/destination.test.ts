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
import type { FailoverDestination, FailoverObjectStore } from "./types";

const store: FailoverObjectStore = {
  endpoint: "https://tor1.digitaloceanspaces.com",
  region: "us-east-1",
  bucket: "rigel-failover",
  accessKey: "KEY",
  secretKey: "SECRET",
  addressing: "virtualHost",
};

const valid: FailoverDestination = {
  provider: "digitalocean",
  token: "dop_v1_abc",
  region: "tor1",
  nodeSize: "s-4vcpu-8gb",
  nodeCount: 2,
};

const withStore: FailoverDestination = { ...valid, objectStore: store };

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
  });

  it("is configured with a token alone; the object store is optional", () => {
    expect(parseFailoverDestination(serializeFailoverDestination(valid))).toEqual(valid);
  });

  it("round-trips an object store", () => {
    expect(parseFailoverDestination(serializeFailoverDestination(withStore))).toEqual(withStore);
  });

  it("drops a half-filled object store rather than storing something unusable", () => {
    for (const missing of ["endpoint", "region", "bucket", "accessKey", "secretKey", "addressing"] as const) {
      const partial = { ...store, [missing]: "" };
      const parsed = parseFailoverDestination(JSON.stringify({ ...valid, objectStore: partial }));
      expect(parsed).toEqual(valid);
    }
  });

  it("drops an object store whose addressing is not one of the two styles", () => {
    const bad = { ...store, addressing: "sideways" };
    expect(parseFailoverDestination(JSON.stringify({ ...valid, objectStore: bad }))).toEqual(valid);
  });

  it("still reads a blob written by the old form, ignoring its unused Spaces keys", () => {
    const old = JSON.stringify({
      provider: "digitalocean",
      token: "dop_v1_abc",
      spacesKey: "KEY",
      spacesSecret: "SECRET",
      region: "tor1",
      nodeSize: "s-4vcpu-8gb",
      nodeCount: 2,
    });
    expect(parseFailoverDestination(old)).toEqual(valid);
  });

  it("fills region, size and count from the documented defaults", () => {
    expect(parseFailoverDestination(JSON.stringify({ provider: "digitalocean", token: "t" }))).toEqual({
      provider: "digitalocean",
      token: "t",
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
    const view = maskFailoverDestination(withStore);
    expect(view).toEqual({
      configured: true,
      provider: "digitalocean",
      tokenSet: true,
      region: "tor1",
      nodeSize: "s-4vcpu-8gb",
      nodeCount: 2,
      objectStore: {
        endpoint: "https://tor1.digitaloceanspaces.com",
        region: "us-east-1",
        bucket: "rigel-failover",
        addressing: "virtualHost",
        accessKeySet: true,
        secretKeySet: true,
      },
    });
    const json = JSON.stringify(view);
    expect(json).not.toContain("dop_v1_abc");
    expect(json).not.toContain("SECRET");
    expect(json).not.toContain("KEY");
  });

  it("omits the object store entirely when there is none", () => {
    expect(maskFailoverDestination(valid).objectStore).toBeUndefined();
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
  it("needs only a token to create a destination", () => {
    expect(applyFailoverPatch(null, { region: "tor1" })).toBeNull();
    expect(applyFailoverPatch(null, { token: "t" })).toMatchObject({
      token: "t",
      region: DEFAULT_FAILOVER_REGION,
    });
  });

  it("keeps the stored token when the patch omits it", () => {
    expect(applyFailoverPatch(valid, { region: "nyc3", nodeCount: 3 })).toEqual({
      ...valid,
      region: "nyc3",
      nodeCount: 3,
    });
  });

  it("keeps stored object store secrets when the patch omits them", () => {
    const patched = applyFailoverPatch(withStore, {
      objectStore: { endpoint: store.endpoint, region: store.region, bucket: "moved" },
    });
    expect(patched?.objectStore).toEqual({ ...store, bucket: "moved" });
  });

  it("adds an object store to a destination that had none", () => {
    expect(applyFailoverPatch(valid, { objectStore: store })?.objectStore).toEqual(store);
  });

  it("removes the object store when the patch sends null", () => {
    expect(applyFailoverPatch(withStore, { objectStore: null })?.objectStore).toBeUndefined();
  });

  it("drops an object store patch that leaves it half-filled", () => {
    expect(applyFailoverPatch(valid, { objectStore: { endpoint: "https://s3.example.net" } })?.objectStore)
      .toBeUndefined();
  });

  it("carries the last selection over", () => {
    const withSel = { ...valid, lastSelection: { kind: "namespace" as const, namespace: "default" } };
    expect(applyFailoverPatch(withSel, { nodeCount: 4 })?.lastSelection).toEqual(withSel.lastSelection);
  });
});
