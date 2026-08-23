import { describe, it, expect } from "vitest";
import { byUid, challengeNode, orderNode, issuerRefLabel } from "./acmeChain";
import type { Order, Challenge } from "@/panels/certificates/types";

function order(p: Partial<Order["metadata"]> & { name: string }, status?: Order["status"], spec?: Order["spec"]): Order {
  return { metadata: { uid: p.name + "-uid", namespace: "default", ...p }, spec, status };
}

function challenge(p: Partial<Challenge["metadata"]> & { name: string }, status?: Challenge["status"], spec?: Challenge["spec"]): Challenge {
  return { metadata: { uid: p.name + "-uid", namespace: "default", ...p }, spec, status };
}

describe("byUid", () => {
  it("matches when a uid is present among the given references", () => {
    expect(byUid([{ uid: "a" }, { uid: "b" }], "b")).toBe(true);
    expect(byUid([{ uid: "a" }], "z")).toBe(false);
  });

  it("tolerates missing references", () => {
    expect(byUid(undefined, "z")).toBe(false);
  });
});

describe("issuerRefLabel", () => {
  it("formats kind/name", () => {
    expect(issuerRefLabel({ kind: "ClusterIssuer", name: "le" })).toBe("ClusterIssuer/le");
  });

  it("formats a bare name when kind is absent", () => {
    expect(issuerRefLabel({ name: "le" })).toBe("le");
  });

  it("falls back to dash when unset", () => {
    expect(issuerRefLabel(undefined)).toBe("—");
  });
});

describe("challengeNode", () => {
  it("maps fields with dash fallbacks", () => {
    const ch = challenge({ name: "ch1" });
    const node = challengeNode(ch);
    expect(node.name).toBe("ch1");
    expect(node.uid).toBe("ch1-uid");
    expect(node.type).toBe("—");
    expect(node.dnsName).toBe("—");
    expect(node.token).toBe("—");
    expect(node.state).toBe("—");
    expect(node.reason).toBe("");
  });

  it("populates uid from metadata", () => {
    const ch = challenge({ name: "ch1", uid: "explicit-uid" });
    expect(challengeNode(ch).uid).toBe("explicit-uid");
  });

  it("populates token from spec.token", () => {
    const ch = challenge({ name: "ch1" }, undefined, { token: "tok-123" });
    expect(challengeNode(ch).token).toBe("tok-123");
  });

  it("populates createdAt from the creation timestamp", () => {
    const ch = challenge({ name: "ch1", creationTimestamp: "2026-01-01T00:00:00Z" });
    expect(challengeNode(ch).createdAt).toBe("2026-01-01T00:00:00Z");
  });
});

describe("orderNode", () => {
  it("maps state/reason with dash fallback", () => {
    const node = orderNode(order({ name: "o1" }), []);
    expect(node.state).toBe("—");
    expect(node.reason).toBe("");
  });

  it("populates uid and createdAt", () => {
    const node = orderNode(order({ name: "o1", creationTimestamp: "2026-02-01T00:00:00Z" }), []);
    expect(node.uid).toBe("o1-uid");
    expect(node.createdAt).toBe("2026-02-01T00:00:00Z");
  });

  it("derives issuer via issuerRefLabel", () => {
    const o = order({ name: "o1" }, undefined, { issuerRef: { kind: "ClusterIssuer", name: "le" } });
    expect(orderNode(o, []).issuer).toBe("ClusterIssuer/le");
  });

  it("falls back to dash for issuer when spec is absent", () => {
    expect(orderNode(order({ name: "o1" }), []).issuer).toBe("—");
  });

  it("filters challenges by ownerReferences uid", () => {
    const o = order({ name: "o1" });
    const mine = challenge(
      { name: "ch-mine", ownerReferences: [{ uid: "o1-uid", kind: "Order", name: "o1" }] },
      { state: "pending", reason: "waiting" },
      { type: "HTTP-01" },
    );
    const other = challenge({ name: "ch-other", ownerReferences: [{ uid: "other-uid", kind: "Order", name: "o2" }] });

    const node = orderNode(o, [mine, other]);
    expect(node.challenges).toHaveLength(1);
    expect(node.challenges[0]!.name).toBe("ch-mine");
    expect(node.challenges[0]!.type).toBe("HTTP-01");
    expect(node.challenges[0]!.state).toBe("pending");
  });
});
