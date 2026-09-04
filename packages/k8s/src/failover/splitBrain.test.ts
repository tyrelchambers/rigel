import { describe, expect, it } from "vitest";
import { bothSidesNonZero, localWritesAfterFailover, scaleDownOnReturn } from "./splitBrain";

describe("scaleDownOnReturn", () => {
  it("holds workloads that no Ingress actually routes to, even in the same namespace", () => {
    const out = scaleDownOnReturn(
      [
        { kind: "Deployment", namespace: "default", name: "reddex-deploy" },
        { kind: "Ingress", namespace: "default", name: "reddex" },
        { kind: "Deployment", namespace: "default", name: "esports-bot" },
        { kind: "Deployment", namespace: "dynamic-sites", name: "k8s-ingressor-deploy" },
      ],
      [{ namespace: "default", name: "reddex-deploy" }],
    );
    expect(out.map((m) => m.name).sort()).toEqual(["esports-bot", "k8s-ingressor-deploy"]);
  });
});

describe("restore guards", () => {
  it("refuses success while both sides are non-zero", () => {
    expect(bothSidesNonZero([{ name: "web", replicas: 1 }], [{ name: "web", replicas: 1 }])).toBe(true);
    expect(bothSidesNonZero([{ name: "web", replicas: 0 }], [{ name: "web", replicas: 1 }])).toBe(false);
  });

  it("detects local writes after the failover timestamp", () => {
    expect(localWritesAfterFailover("2026-09-02T20:00:00.000Z", "2026-09-02T18:00:00.000Z")).toBe(true);
    expect(localWritesAfterFailover("2026-09-02T17:00:00.000Z", "2026-09-02T18:00:00.000Z")).toBe(false);
    expect(localWritesAfterFailover(undefined, "2026-09-02T18:00:00.000Z")).toBe(false);
  });
});
