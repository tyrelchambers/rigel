import { describe, it, expect } from "vitest";
import { certRules } from "./certs";

const now = new Date("2026-09-02T12:00:00Z");

function certificate(status: Record<string, any>): Record<string, any> {
  return { metadata: { name: "web-tls", namespace: "default" }, status };
}

function order(state: string, over: Record<string, any> = {}): Record<string, any> {
  return {
    metadata: {
      name: "web-tls-1",
      namespace: "default",
      creationTimestamp: "2026-09-02T11:00:00Z",
    },
    status: { state, ...over },
  };
}

function challenge(state: string, creationTimestamp: string): Record<string, any> {
  return {
    metadata: { name: "web-tls-1-0", namespace: "default", creationTimestamp },
    status: { state },
  };
}

function release(status: string): Record<string, any> {
  return { name: "ingress-nginx", namespace: "kube-system", status };
}

describe("certificateNotReady", () => {
  it("fires when the Ready condition is False", () => {
    const out = certRules(
      {
        certificates: [
          certificate({
            conditions: [
              {
                type: "Ready",
                status: "False",
                message: "Issuing certificate as Secret does not exist",
                lastTransitionTime: "2026-09-01T09:00:00Z",
              },
            ],
          }),
        ],
      },
      now,
    );
    expect(out.map((i) => i.rule)).toEqual(["certificateNotReady"]);
    expect(out[0].severity).toBe("warning");
    expect(out[0].subject).toEqual({
      kind: "Certificate",
      namespace: "default",
      name: "web-tls",
    });
    expect(out[0].evidence).toBe("Issuing certificate as Secret does not exist");
    expect(out[0].onsetAt).toBe("2026-09-01T09:00:00Z");
  });

  it("does not fire when the Ready condition is True", () => {
    const out = certRules(
      { certificates: [certificate({ conditions: [{ type: "Ready", status: "True" }] })] },
      now,
    );
    expect(out).toEqual([]);
  });

  it("does not fire before the Ready condition is reported", () => {
    expect(certRules({ certificates: [certificate({})] }, now)).toEqual([]);
  });
});

describe("certificateExpiringSoon", () => {
  it("fires when the certificate expires inside the warning window", () => {
    const out = certRules(
      {
        certificates: [
          certificate({
            conditions: [{ type: "Ready", status: "True" }],
            notAfter: "2026-09-07T12:00:00Z",
          }),
        ],
      },
      now,
    );
    expect(out.map((i) => i.rule)).toEqual(["certificateExpiringSoon"]);
    expect(out[0].severity).toBe("warning");
    expect(out[0].evidence).toBeUndefined();
  });

  it("does not fire well outside the warning window", () => {
    const out = certRules(
      {
        certificates: [
          certificate({
            conditions: [{ type: "Ready", status: "True" }],
            notAfter: "2026-11-01T12:00:00Z",
          }),
        ],
      },
      now,
    );
    expect(out).toEqual([]);
  });

  it("does not fire when the certificate has no expiry yet", () => {
    const out = certRules(
      { certificates: [certificate({ conditions: [{ type: "Ready", status: "True" }] })] },
      now,
    );
    expect(out).toEqual([]);
  });
});

describe("acmeOrderFailed", () => {
  it("fires on an errored order and quotes the ACME reason", () => {
    const out = certRules(
      { orders: [order("errored", { reason: "Order failed: rate limited" })] },
      now,
    );
    expect(out.map((i) => i.rule)).toEqual(["acmeOrderFailed"]);
    expect(out[0].severity).toBe("critical");
    expect(out[0].evidence).toBe("Order failed: rate limited");
    expect(out[0].subject).toEqual({ kind: "Order", namespace: "default", name: "web-tls-1" });
  });

  it("fires on an invalid order", () => {
    const out = certRules({ orders: [order("invalid")] }, now);
    expect(out.map((i) => i.rule)).toEqual(["acmeOrderFailed"]);
  });

  it("does not fire on an order still in progress", () => {
    expect(certRules({ orders: [order("pending")] }, now)).toEqual([]);
  });

  it("does not fire on an order in state ready, which is not terminal", () => {
    expect(certRules({ orders: [order("ready")] }, now)).toEqual([]);
  });

  it("does not fire on a valid order", () => {
    expect(certRules({ orders: [order("valid")] }, now)).toEqual([]);
  });
});

describe("acmeChallengeStuck", () => {
  it("fires on a challenge pending past the stuck window", () => {
    const out = certRules(
      { challenges: [challenge("pending", "2026-09-02T11:00:00Z")] },
      now,
    );
    expect(out.map((i) => i.rule)).toEqual(["acmeChallengeStuck"]);
    expect(out[0].severity).toBe("warning");
    expect(out[0].onsetAt).toBe("2026-09-02T11:00:00Z");
    expect(out[0].subject).toEqual({
      kind: "Challenge",
      namespace: "default",
      name: "web-tls-1-0",
    });
  });

  it("does not fire on a challenge pending inside the window", () => {
    const out = certRules({ challenges: [challenge("pending", "2026-09-02T11:45:00Z")] }, now);
    expect(out).toEqual([]);
  });

  it("does not fire on an old challenge that already passed", () => {
    const out = certRules({ challenges: [challenge("valid", "2026-09-02T11:00:00Z")] }, now);
    expect(out).toEqual([]);
  });
});

describe("helmReleaseFailed", () => {
  it("fires on a failed release", () => {
    const out = certRules({ helmReleases: [release("failed")] }, now);
    expect(out.map((i) => i.rule)).toEqual(["helmReleaseFailed"]);
    expect(out[0].severity).toBe("critical");
    expect(out[0].subject).toEqual({
      kind: "HelmRelease",
      namespace: "kube-system",
      name: "ingress-nginx",
    });
  });

  it("fires on a release stuck mid-upgrade", () => {
    const out = certRules({ helmReleases: [release("pending-upgrade")] }, now);
    expect(out.map((i) => i.rule)).toEqual(["helmReleaseFailed"]);
  });

  it("does not fire on a deployed release", () => {
    expect(certRules({ helmReleases: [release("deployed")] }, now)).toEqual([]);
  });

  it("does not fire on a superseded revision", () => {
    expect(certRules({ helmReleases: [release("superseded")] }, now)).toEqual([]);
  });
});
