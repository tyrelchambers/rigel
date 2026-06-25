import { describe, it, expect } from "vitest";
import {
  isReady,
  isIssuing,
  issuerLabel,
  buildCertViews,
  matchesSearch,
  sortCertViews,
  expiryLabel,
  expiresPhrase,
  agePhrase,
  notAfterRelative,
  absoluteDate,
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

// ---------------------------------------------------------------------------
// New spelled-duration helpers
// ---------------------------------------------------------------------------

describe("expiresPhrase", () => {
  const now = Date.parse("2026-06-19T00:00:00Z");
  const iso = (deltaSeconds: number) => new Date(now + deltaSeconds * 1000).toISOString();

  it("returns empty string for missing or unparseable input", () => {
    expect(expiresPhrase(undefined, now)).toBe("");
    expect(expiresPhrase("not-a-date", now)).toBe("");
  });

  it("returns 'Expires in N days' for future dates", () => {
    expect(expiresPhrase(iso(62 * 86400), now)).toBe("Expires in 62 days");
    expect(expiresPhrase(iso(1 * 86400), now)).toBe("Expires in 1 day");
  });

  it("returns 'Expires in N hours' for sub-day future", () => {
    expect(expiresPhrase(iso(3 * 3600), now)).toBe("Expires in 3 hours");
    expect(expiresPhrase(iso(1 * 3600), now)).toBe("Expires in 1 hour");
  });

  it("returns 'Expires in N minutes' for sub-hour future", () => {
    expect(expiresPhrase(iso(5 * 60), now)).toBe("Expires in 5 minutes");
    expect(expiresPhrase(iso(1 * 60), now)).toBe("Expires in 1 minute");
  });

  it("returns 'Expires in N seconds' for sub-minute future", () => {
    expect(expiresPhrase(iso(45), now)).toBe("Expires in 45 seconds");
    expect(expiresPhrase(iso(1), now)).toBe("Expires in 1 second");
  });

  it("returns 'Expired N days ago' for past dates", () => {
    expect(expiresPhrase(iso(-5 * 86400), now)).toBe("Expired 5 days ago");
    expect(expiresPhrase(iso(-1 * 86400), now)).toBe("Expired 1 day ago");
  });

  it("returns 'Expired N hours ago' for recently past", () => {
    expect(expiresPhrase(iso(-2 * 3600), now)).toBe("Expired 2 hours ago");
  });
});

describe("agePhrase", () => {
  const now = Date.parse("2026-06-19T00:00:00Z");
  const iso = (deltaSeconds: number) => new Date(now - deltaSeconds * 1000).toISOString();

  it("returns empty string for missing or unparseable input", () => {
    expect(agePhrase(undefined, now)).toBe("");
    expect(agePhrase("bad-date", now)).toBe("");
  });

  it("returns 'Created N days ago'", () => {
    expect(agePhrase(iso(27 * 86400), now)).toBe("Created 27 days ago");
    expect(agePhrase(iso(1 * 86400), now)).toBe("Created 1 day ago");
  });

  it("returns 'Created N hours ago' for sub-day", () => {
    expect(agePhrase(iso(5 * 3600), now)).toBe("Created 5 hours ago");
    expect(agePhrase(iso(1 * 3600), now)).toBe("Created 1 hour ago");
  });

  it("returns 'Created N minutes ago' for sub-hour", () => {
    expect(agePhrase(iso(30 * 60), now)).toBe("Created 30 minutes ago");
  });

  it("returns 'Created N seconds ago' for sub-minute", () => {
    expect(agePhrase(iso(10), now)).toBe("Created 10 seconds ago");
  });
});

describe("notAfterRelative", () => {
  const now = Date.parse("2026-06-19T00:00:00Z");
  const iso = (deltaSeconds: number) => new Date(now + deltaSeconds * 1000).toISOString();

  it("returns '—' for missing or unparseable input", () => {
    expect(notAfterRelative(undefined, now)).toBe("—");
    expect(notAfterRelative("bad", now)).toBe("—");
  });

  it("returns 'in N days' for future", () => {
    expect(notAfterRelative(iso(62 * 86400), now)).toBe("in 62 days");
    expect(notAfterRelative(iso(1 * 86400), now)).toBe("in 1 day");
  });

  it("returns 'expired N days ago' for past", () => {
    expect(notAfterRelative(iso(-5 * 86400), now)).toBe("expired 5 days ago");
    expect(notAfterRelative(iso(-1 * 86400), now)).toBe("expired 1 day ago");
  });

  it("handles hours and minutes", () => {
    expect(notAfterRelative(iso(3 * 3600), now)).toBe("in 3 hours");
    expect(notAfterRelative(iso(-2 * 3600), now)).toBe("expired 2 hours ago");
    expect(notAfterRelative(iso(5 * 60), now)).toBe("in 5 minutes");
  });
});

describe("absoluteDate", () => {
  it("returns '—' for missing or unparseable input", () => {
    expect(absoluteDate(undefined)).toBe("—");
    expect(absoluteDate("bad-date")).toBe("—");
  });

  it("formats an ISO string as 'Mon D, YYYY'", () => {
    // Use a fixed date and check the format shape without locale-dep on exact string
    const result = absoluteDate("2026-08-20T00:00:00Z");
    expect(result).toMatch(/^[A-Z][a-z]+ \d+, \d{4}$/);
  });
});
