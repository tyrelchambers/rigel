import { describe, it, expect } from "vitest";
import {
  isReady,
  isIssuing,
  issuerLabel,
  buildCertViews,
  matchesSearch,
  sortCertViews,
  expiryLabel,
} from "./certificatesDisplay";
import type { Certificate, CertificateRequest, Order, Challenge } from "./types";

function cert(p: Partial<Certificate["metadata"]> & { name: string }, status?: Certificate["status"], spec?: Certificate["spec"]): Certificate {
  return { metadata: { uid: p.name + "-uid", namespace: "default", ...p }, spec, status };
}

describe("isReady / isIssuing", () => {
  it("reads the Ready condition", () => {
    expect(isReady(cert({ name: "a" }, { conditions: [{ type: "Ready", status: "True" }] }))).toBe(true);
    expect(isReady(cert({ name: "a" }, { conditions: [{ type: "Ready", status: "False" }] }))).toBe(false);
    expect(isReady(cert({ name: "a" }))).toBe(false);
  });
  it("reads the Issuing condition", () => {
    expect(isIssuing(cert({ name: "a" }, { conditions: [{ type: "Issuing", status: "True" }] }))).toBe(true);
    expect(isIssuing(cert({ name: "a" }))).toBe(false);
  });
});

describe("expiryLabel", () => {
  const now = Date.parse("2026-06-19T00:00:00Z");
  const iso = (deltaSeconds: number) => new Date(now + deltaSeconds * 1000).toISOString();

  it("returns a dash for missing or unparseable input", () => {
    expect(expiryLabel(undefined, now)).toBe("—");
    expect(expiryLabel("not-a-date", now)).toBe("—");
  });

  it("formats future expiry as 'in <largest unit>'", () => {
    expect(expiryLabel(iso(344 * 86400), now)).toBe("in 344d");
    expect(expiryLabel(iso(3 * 3600), now)).toBe("in 3h");
    expect(expiryLabel(iso(5 * 60), now)).toBe("in 5m");
    expect(expiryLabel(iso(45), now)).toBe("in 45s");
  });

  it("treats exactly-now as not yet expired", () => {
    expect(expiryLabel(iso(0), now)).toBe("in 0s");
  });

  it("formats past expiry as 'expired <largest unit> ago'", () => {
    expect(expiryLabel(iso(-5 * 60), now)).toBe("expired 5m ago");
    expect(expiryLabel(iso(-2 * 86400), now)).toBe("expired 2d ago");
  });
});

describe("issuerLabel", () => {
  it("formats kind/name, falling back to dash", () => {
    expect(issuerLabel(cert({ name: "a" }, undefined, { issuerRef: { kind: "ClusterIssuer", name: "le" } }))).toBe("ClusterIssuer/le");
    expect(issuerLabel(cert({ name: "a" }))).toBe("—");
  });
});

describe("buildCertViews — chain join", () => {
  it("joins request → order → challenge by annotation + ownerReferences", () => {
    const c = cert({ name: "app-tls", uid: "cert-uid" }, { conditions: [{ type: "Issuing", status: "True" }] }, { dnsNames: ["app.example.com"], secretName: "app-tls" });
    const cr: CertificateRequest = {
      metadata: { name: "app-tls-1", uid: "cr-uid", namespace: "default", annotations: { "cert-manager.io/certificate-name": "app-tls" } },
      status: { conditions: [{ type: "Ready", status: "False", reason: "Pending" }] },
    };
    const order: Order = {
      metadata: { name: "app-tls-1-abc", uid: "order-uid", namespace: "default", ownerReferences: [{ uid: "cr-uid", kind: "CertificateRequest", name: "app-tls-1" }] },
      status: { state: "pending", reason: "" },
    };
    const ch: Challenge = {
      metadata: { name: "app-tls-1-abc-0", uid: "ch-uid", namespace: "default", ownerReferences: [{ uid: "order-uid", kind: "Order", name: "app-tls-1-abc" }] },
      spec: { type: "HTTP-01", dnsName: "app.example.com" },
      status: { state: "pending", reason: "waiting" },
    };

    const views = buildCertViews([c], [cr], [order], [ch]);
    expect(views).toHaveLength(1);
    const v = views[0]!;
    expect(v.name).toBe("app-tls");
    expect(v.issuing).toBe(true);
    expect(v.dnsNames).toEqual(["app.example.com"]);
    expect(v.requests).toHaveLength(1);
    expect(v.requests[0]!.order!.name).toBe("app-tls-1-abc");
    expect(v.requests[0]!.order!.challenges[0]!.type).toBe("HTTP-01");
    expect(v.requests[0]!.order!.challenges[0]!.state).toBe("pending");
  });

  it("attaches multiple requests newest-first and tolerates orphans", () => {
    const c = cert({ name: "x", uid: "x-uid" });
    const older: CertificateRequest = { metadata: { name: "x-1", uid: "cr1", namespace: "default", creationTimestamp: "2026-01-01T00:00:00Z", annotations: { "cert-manager.io/certificate-name": "x" } } };
    const newer: CertificateRequest = { metadata: { name: "x-2", uid: "cr2", namespace: "default", creationTimestamp: "2026-02-01T00:00:00Z", annotations: { "cert-manager.io/certificate-name": "x" } } };
    const orphanOrder: Order = { metadata: { name: "lost", uid: "o", namespace: "default", ownerReferences: [{ uid: "nope", kind: "CertificateRequest", name: "?" }] } };

    const views = buildCertViews([c], [older, newer], [orphanOrder], []);
    expect(views[0]!.requests.map((r) => r.name)).toEqual(["x-2", "x-1"]);
    expect(views[0]!.requests[0]!.order).toBeNull();
  });

  it("renders a Ready cert with no requests (empty chain)", () => {
    const c = cert({ name: "steady", uid: "s" }, { conditions: [{ type: "Ready", status: "True" }], notAfter: "2099-01-01T00:00:00Z" });
    const views = buildCertViews([c], [], [], []);
    expect(views[0]!.ready).toBe(true);
    expect(views[0]!.requests).toEqual([]);
  });
});

describe("matchesSearch / sortCertViews", () => {
  it("matches on name, namespace, dnsNames", () => {
    const c = cert({ name: "web-tls", namespace: "prod" }, undefined, { dnsNames: ["shop.example.com"] });
    const v = buildCertViews([c], [], [], [])[0]!;
    expect(matchesSearch(v, "shop")).toBe(true);
    expect(matchesSearch(v, "prod")).toBe(true);
    expect(matchesSearch(v, "nope")).toBe(false);
    expect(matchesSearch(v, "")).toBe(true);
  });
  it("sorts by namespace then name", () => {
    const a = buildCertViews([cert({ name: "b", namespace: "ns1" })], [], [], [])[0]!;
    const b = buildCertViews([cert({ name: "a", namespace: "ns2" })], [], [], [])[0]!;
    expect(sortCertViews([b, a]).map((v) => v.name)).toEqual(["b", "a"]);
  });
});
