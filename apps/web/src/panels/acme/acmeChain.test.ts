import { describe, it, expect } from "vitest";
import {
  byUid, challengeNode, orderNode, issuerRefLabel,
  certificateForOrder, buildOrderRows, matchesOrderSearch, matchesChallengeSearch,
  matchesAcmeState, acmeStateVariant, orderSortOptions, challengeSortOptions,
  CERT_NAME_ANNOTATION,
} from "./acmeChain";
import type { Order, Challenge, CertificateRequest, Certificate } from "@/panels/certificates/types";

function order(p: Partial<Order["metadata"]> & { name: string }, status?: Order["status"], spec?: Order["spec"]): Order {
  return { metadata: { uid: p.name + "-uid", namespace: "default", ...p }, spec, status };
}

function challenge(p: Partial<Challenge["metadata"]> & { name: string }, status?: Challenge["status"], spec?: Challenge["spec"]): Challenge {
  return { metadata: { uid: p.name + "-uid", namespace: "default", ...p }, spec, status };
}

function request(p: Partial<CertificateRequest["metadata"]> & { name: string }, status?: CertificateRequest["status"]): CertificateRequest {
  return { metadata: { uid: p.name + "-uid", namespace: "default", ...p }, status };
}

function cert(p: Partial<Certificate["metadata"]> & { name: string }, spec?: Certificate["spec"], status?: Certificate["status"]): Certificate {
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

describe("certificateForOrder", () => {
  it("resolves name, namespace, and cert uid through request ownerRef and annotation", () => {
    const o = order({ name: "o1", ownerReferences: [{ uid: "req1-uid", kind: "CertificateRequest", name: "req1" }] });
    const req = request({ name: "req1", annotations: { [CERT_NAME_ANNOTATION]: "site-tls" } });
    const c = cert({ name: "site-tls" });

    expect(certificateForOrder(o, [req], [c])).toEqual({ name: "site-tls", namespace: "default", uid: "site-tls-uid" });
  });

  it("returns name/namespace with no uid when the Certificate object is missing", () => {
    const o = order({ name: "o1", ownerReferences: [{ uid: "req1-uid", kind: "CertificateRequest", name: "req1" }] });
    const req = request({ name: "req1", annotations: { [CERT_NAME_ANNOTATION]: "site-tls" } });

    expect(certificateForOrder(o, [req], [])).toEqual({ name: "site-tls", namespace: "default", uid: undefined });
  });

  it("returns null when there is no owning request", () => {
    const o = order({ name: "o1", ownerReferences: [{ uid: "other-uid", kind: "CertificateRequest", name: "other" }] });
    const req = request({ name: "req1", annotations: { [CERT_NAME_ANNOTATION]: "site-tls" } });

    expect(certificateForOrder(o, [req], [])).toBeNull();
  });

  it("returns null when the owning request has no certificate-name annotation", () => {
    const o = order({ name: "o1", ownerReferences: [{ uid: "req1-uid", kind: "CertificateRequest", name: "req1" }] });
    const req = request({ name: "req1" });

    expect(certificateForOrder(o, [req], [])).toBeNull();
  });
});

describe("buildOrderRows", () => {
  it("attaches the resolved certificate to an owned order and null to an orphaned one", () => {
    const owned = order(
      { name: "owned-order", ownerReferences: [{ uid: "req1-uid", kind: "CertificateRequest", name: "req1" }] },
      { state: "valid", reason: "" },
      { issuerRef: { kind: "ClusterIssuer", name: "le" } },
    );
    const orphan = order({ name: "orphan-order" }, { state: "errored", reason: "timed out" });
    const req = request({ name: "req1", annotations: { [CERT_NAME_ANNOTATION]: "site-tls" } });
    const c = cert({ name: "site-tls" });

    const rows = buildOrderRows([owned, orphan], [], [req], [c]);

    expect(rows).toHaveLength(2);
    const ownedRow = rows.find((r) => r.name === "owned-order")!;
    expect(ownedRow.namespace).toBe("default");
    expect(ownedRow.uid).toBe("owned-order-uid");
    expect(ownedRow.issuer).toBe("ClusterIssuer/le");
    expect(ownedRow.state).toBe("valid");
    expect(ownedRow.certificate).toEqual({ name: "site-tls", namespace: "default", uid: "site-tls-uid" });

    const orphanRow = rows.find((r) => r.name === "orphan-order")!;
    expect(orphanRow.state).toBe("errored");
    expect(orphanRow.reason).toBe("timed out");
    expect(orphanRow.certificate).toBeNull();
  });
});

describe("matchesOrderSearch", () => {
  const row = buildOrderRows(
    [order(
      { name: "web-order", ownerReferences: [{ uid: "req1-uid", kind: "CertificateRequest", name: "req1" }] },
      { state: "pending", reason: "waiting-on-dns" },
    )],
    [],
    [request({ name: "req1", annotations: { [CERT_NAME_ANNOTATION]: "site-tls" } })],
    [cert({ name: "site-tls" })],
  )[0]!;

  it("matches on name case-insensitively", () => {
    expect(matchesOrderSearch(row, "WEB-ORDER")).toBe(true);
  });

  it("matches on namespace", () => {
    expect(matchesOrderSearch(row, "default")).toBe(true);
  });

  it("matches on certificate name", () => {
    expect(matchesOrderSearch(row, "site-tls")).toBe(true);
  });

  it("matches on state", () => {
    expect(matchesOrderSearch(row, "pending")).toBe(true);
  });

  it("matches on reason", () => {
    expect(matchesOrderSearch(row, "waiting-on-dns")).toBe(true);
  });

  it("does not match unrelated text", () => {
    expect(matchesOrderSearch(row, "zzz")).toBe(false);
  });

  it("matches everything for an empty or whitespace query", () => {
    expect(matchesOrderSearch(row, "")).toBe(true);
    expect(matchesOrderSearch(row, "   ")).toBe(true);
  });
});

describe("matchesChallengeSearch", () => {
  const node = challengeNode(challenge(
    { name: "ch-web" },
    { state: "processing", reason: "self-check-in-progress" },
    { type: "HTTP-01", dnsName: "shop.example.com" },
  ));

  it("matches on name case-insensitively", () => {
    expect(matchesChallengeSearch(node, "CH-WEB")).toBe(true);
  });

  it("matches on namespace", () => {
    expect(matchesChallengeSearch(node, "default")).toBe(true);
  });

  it("matches on dnsName", () => {
    expect(matchesChallengeSearch(node, "shop.example")).toBe(true);
  });

  it("matches on type", () => {
    expect(matchesChallengeSearch(node, "http-01")).toBe(true);
  });

  it("matches on state", () => {
    expect(matchesChallengeSearch(node, "processing")).toBe(true);
  });

  it("matches on reason", () => {
    expect(matchesChallengeSearch(node, "self-check")).toBe(true);
  });

  it("does not match unrelated text", () => {
    expect(matchesChallengeSearch(node, "zzz")).toBe(false);
  });

  it("matches everything for an empty or whitespace query", () => {
    expect(matchesChallengeSearch(node, "")).toBe(true);
    expect(matchesChallengeSearch(node, "   ")).toBe(true);
  });
});

describe("matchesAcmeState", () => {
  it("'all' matches every known state, unknown states, and the dash placeholder", () => {
    for (const s of ["valid", "ready", "pending", "processing", "invalid", "errored", "expired", "bogus", "—"]) {
      expect(matchesAcmeState(s, "all")).toBe(true);
    }
  });

  it("'active' matches pending/processing only", () => {
    expect(matchesAcmeState("pending", "active")).toBe(true);
    expect(matchesAcmeState("processing", "active")).toBe(true);
    expect(matchesAcmeState("valid", "active")).toBe(false);
  });

  it("'failed' matches invalid/errored/expired only", () => {
    expect(matchesAcmeState("invalid", "failed")).toBe(true);
    expect(matchesAcmeState("errored", "failed")).toBe(true);
    expect(matchesAcmeState("expired", "failed")).toBe(true);
    expect(matchesAcmeState("valid", "failed")).toBe(false);
  });

  it("'valid' matches valid/ready only", () => {
    expect(matchesAcmeState("valid", "valid")).toBe(true);
    expect(matchesAcmeState("ready", "valid")).toBe(true);
    expect(matchesAcmeState("pending", "valid")).toBe(false);
  });

  it("matches state case-insensitively", () => {
    expect(matchesAcmeState("PENDING", "active")).toBe(true);
  });

  it("an unknown state matches only 'all'", () => {
    expect(matchesAcmeState("bogus", "active")).toBe(false);
    expect(matchesAcmeState("bogus", "failed")).toBe(false);
    expect(matchesAcmeState("bogus", "valid")).toBe(false);
    expect(matchesAcmeState("bogus", "all")).toBe(true);
  });

  it("the dash placeholder matches only 'all'", () => {
    expect(matchesAcmeState("—", "active")).toBe(false);
    expect(matchesAcmeState("—", "failed")).toBe(false);
    expect(matchesAcmeState("—", "valid")).toBe(false);
    expect(matchesAcmeState("—", "all")).toBe(true);
  });
});

describe("acmeStateVariant", () => {
  it("maps valid/ready to healthy", () => {
    expect(acmeStateVariant("valid")).toBe("healthy");
    expect(acmeStateVariant("ready")).toBe("healthy");
  });

  it("maps pending/processing to pending", () => {
    expect(acmeStateVariant("pending")).toBe("pending");
    expect(acmeStateVariant("processing")).toBe("pending");
  });

  it("maps invalid/errored/expired to error", () => {
    expect(acmeStateVariant("invalid")).toBe("error");
    expect(acmeStateVariant("errored")).toBe("error");
    expect(acmeStateVariant("expired")).toBe("error");
  });

  it("falls back to neutral for anything else, including the dash placeholder", () => {
    expect(acmeStateVariant("—")).toBe("neutral");
    expect(acmeStateVariant("bogus")).toBe("neutral");
  });
});

describe("orderSortOptions", () => {
  const options = orderSortOptions();
  const rowFor = (name: string, namespace: string, state: string, createdAt?: string) =>
    buildOrderRows([order({ name, namespace, creationTimestamp: createdAt }, { state, reason: "" })], [], [], [])[0]!;

  it("defaults to Namespace, first in the list", () => {
    expect(options[0]!.value).toBe("namespace");
  });

  it("Namespace sorts by namespace then falls back to name", () => {
    const a = rowFor("b-order", "zeta", "valid");
    const b = rowFor("a-order", "alpha", "valid");
    const sort = options.find((o) => o.value === "namespace")!;
    expect(sort.compare(a, b)).toBeGreaterThan(0);

    const tie1 = rowFor("b-order", "same", "valid");
    const tie2 = rowFor("a-order", "same", "valid");
    expect(sort.compare(tie1, tie2)).toBeGreaterThan(0);
  });

  it("Name sorts alphabetically", () => {
    const a = rowFor("b-order", "default", "valid");
    const b = rowFor("a-order", "default", "valid");
    const sort = options.find((o) => o.value === "name")!;
    expect(sort.compare(a, b)).toBeGreaterThan(0);
    expect(sort.compare(b, a)).toBeLessThan(0);
  });

  it("State sorts alphabetically with a name tiebreak", () => {
    const a = rowFor("b-order", "default", "valid");
    const b = rowFor("a-order", "default", "invalid");
    const sort = options.find((o) => o.value === "state")!;
    expect(sort.compare(a, b)).toBeGreaterThan(0);

    const tie1 = rowFor("b-order", "default", "valid");
    const tie2 = rowFor("a-order", "default", "valid");
    expect(sort.compare(tie1, tie2)).toBeGreaterThan(0);
  });

  it("Age sorts oldest-first with a name tiebreak, treating a missing createdAt as oldest", () => {
    const older = rowFor("z-order", "default", "valid", "2026-01-01T00:00:00Z");
    const newer = rowFor("a-order", "default", "valid", "2026-06-01T00:00:00Z");
    const missing = rowFor("m-order", "default", "valid", undefined);
    const sort = options.find((o) => o.value === "age")!;

    expect(sort.compare(older, newer)).toBeLessThan(0);
    expect(sort.compare(newer, older)).toBeGreaterThan(0);
    expect(sort.compare(missing, older)).toBeLessThan(0);

    const tie1 = rowFor("z-order", "default", "valid", undefined);
    const tie2 = rowFor("a-order", "default", "valid", undefined);
    expect(sort.compare(tie1, tie2)).toBeGreaterThan(0);
  });
});

describe("challengeSortOptions", () => {
  const options = challengeSortOptions();
  const nodeFor = (name: string, namespace: string, state: string, type: string, createdAt?: string) =>
    challengeNode(challenge({ name, namespace, creationTimestamp: createdAt }, { state, reason: "" }, { type }));

  it("defaults to Namespace, first in the list", () => {
    expect(options[0]!.value).toBe("namespace");
  });

  it("Namespace sorts by namespace then falls back to name", () => {
    const a = nodeFor("b-ch", "zeta", "valid", "HTTP-01");
    const b = nodeFor("a-ch", "alpha", "valid", "HTTP-01");
    const sort = options.find((o) => o.value === "namespace")!;
    expect(sort.compare(a, b)).toBeGreaterThan(0);

    const tie1 = nodeFor("b-ch", "same", "valid", "HTTP-01");
    const tie2 = nodeFor("a-ch", "same", "valid", "HTTP-01");
    expect(sort.compare(tie1, tie2)).toBeGreaterThan(0);
  });

  it("Name sorts alphabetically", () => {
    const a = nodeFor("b-ch", "default", "valid", "HTTP-01");
    const b = nodeFor("a-ch", "default", "valid", "HTTP-01");
    const sort = options.find((o) => o.value === "name")!;
    expect(sort.compare(a, b)).toBeGreaterThan(0);
    expect(sort.compare(b, a)).toBeLessThan(0);
  });

  it("State sorts alphabetically with a name tiebreak", () => {
    const a = nodeFor("b-ch", "default", "valid", "HTTP-01");
    const b = nodeFor("a-ch", "default", "invalid", "HTTP-01");
    const sort = options.find((o) => o.value === "state")!;
    expect(sort.compare(a, b)).toBeGreaterThan(0);

    const tie1 = nodeFor("b-ch", "default", "valid", "HTTP-01");
    const tie2 = nodeFor("a-ch", "default", "valid", "HTTP-01");
    expect(sort.compare(tie1, tie2)).toBeGreaterThan(0);
  });

  it("Type sorts alphabetically with a name tiebreak", () => {
    const a = nodeFor("b-ch", "default", "valid", "HTTP-01");
    const b = nodeFor("a-ch", "default", "valid", "DNS-01");
    const sort = options.find((o) => o.value === "type")!;
    expect(sort.compare(a, b)).toBeGreaterThan(0);

    const tie1 = nodeFor("b-ch", "default", "valid", "HTTP-01");
    const tie2 = nodeFor("a-ch", "default", "valid", "HTTP-01");
    expect(sort.compare(tie1, tie2)).toBeGreaterThan(0);
  });

  it("Age sorts oldest-first with a name tiebreak, treating a missing createdAt as oldest", () => {
    const older = nodeFor("z-ch", "default", "valid", "HTTP-01", "2026-01-01T00:00:00Z");
    const newer = nodeFor("a-ch", "default", "valid", "HTTP-01", "2026-06-01T00:00:00Z");
    const missing = nodeFor("m-ch", "default", "valid", "HTTP-01", undefined);
    const sort = options.find((o) => o.value === "age")!;

    expect(sort.compare(older, newer)).toBeLessThan(0);
    expect(sort.compare(newer, older)).toBeGreaterThan(0);
    expect(sort.compare(missing, older)).toBeLessThan(0);

    const tie1 = nodeFor("z-ch", "default", "valid", "HTTP-01", undefined);
    const tie2 = nodeFor("a-ch", "default", "valid", "HTTP-01", undefined);
    expect(sort.compare(tie1, tie2)).toBeGreaterThan(0);
  });
});
