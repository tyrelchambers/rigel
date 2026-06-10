import { describe, it, expect } from "vitest";
import { computeFlows, isPodReady, getFlowHealth } from "./connectivityDisplay";
import type { Ingress } from "../ingresses/types";
import type { Service } from "../services/types";
import type { Pod } from "../pods/types";

// ---------------------------------------------------------------------------
// Fixture builders — keep tests terse and intent-focused.
// ---------------------------------------------------------------------------

function ingress(
  name: string,
  ns: string,
  rules: Array<{ host?: string; service?: string; port?: number }>,
): Ingress {
  return {
    metadata: { name, namespace: ns, uid: `ing-${name}` },
    spec: {
      rules: rules.map((r) => ({
        host: r.host,
        http: {
          paths: [
            {
              path: "/",
              backend: r.service
                ? { service: { name: r.service, port: { number: r.port ?? 80 } } }
                : {},
            },
          ],
        },
      })),
    },
  };
}

function service(
  name: string,
  ns: string,
  selector?: Record<string, string>,
  type = "ClusterIP",
): Service {
  return {
    metadata: { name, namespace: ns, uid: `svc-${ns}-${name}` },
    spec: { type, selector },
  };
}

function pod(
  name: string,
  ns: string,
  labels: Record<string, string>,
  opts: { phase?: string; ready?: boolean[] } = {},
): Pod {
  const phase = opts.phase ?? "Running";
  const ready = opts.ready ?? [true];
  return {
    metadata: { name, namespace: ns, uid: `pod-${ns}-${name}`, labels },
    spec: { containers: ready.map((_, i) => ({ name: `c${i}` })) },
    status: {
      phase,
      containerStatuses: ready.map((r, i) => ({ name: `c${i}`, ready: r, restartCount: 0 })),
    },
  };
}

// ---------------------------------------------------------------------------
// isPodReady
// ---------------------------------------------------------------------------

describe("isPodReady", () => {
  it("true when Running and all containers ready", () => {
    expect(isPodReady(pod("p", "default", {}, { ready: [true, true] }))).toBe(true);
  });
  it("false when phase is Pending", () => {
    expect(isPodReady(pod("p", "default", {}, { phase: "Pending" }))).toBe(false);
  });
  it("false when one container not ready", () => {
    expect(isPodReady(pod("p", "default", {}, { ready: [true, false] }))).toBe(false);
  });
  it("false when containerStatuses is empty", () => {
    const p = pod("p", "default", {});
    p.status!.containerStatuses = [];
    expect(isPodReady(p)).toBe(false);
  });
  it("false when status is absent", () => {
    const p = pod("p", "default", {});
    delete p.status;
    expect(isPodReady(p)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getFlowHealth
// ---------------------------------------------------------------------------

describe("getFlowHealth", () => {
  it("ok when no issues", () => {
    expect(getFlowHealth({ issues: [], isExternal: true })).toBe("ok");
  });
  it("broken when external with issues", () => {
    expect(getFlowHealth({ issues: ["x"], isExternal: true })).toBe("broken");
  });
  it("warn when internal with issues", () => {
    expect(getFlowHealth({ issues: ["x"], isExternal: false })).toBe("warn");
  });
});

// ---------------------------------------------------------------------------
// computeFlows
// ---------------------------------------------------------------------------

describe("computeFlows", () => {
  it("basic external flow: Ingress → Service → ready Pod", () => {
    const flows = computeFlows(
      [ingress("web", "default", [{ host: "example.com", service: "api" }])],
      [service("api", "default", { app: "api" })],
      [pod("api-1", "default", { app: "api" })],
    );
    expect(flows).toHaveLength(1);
    const f = flows[0];
    expect(f.id).toBe("default/api");
    expect(f.isExternal).toBe(true);
    expect(f.hosts).toEqual(["example.com"]);
    expect(f.ingressNames).toEqual(["web"]);
    expect(f.serviceExists).toBe(true);
    expect(f.readyPods).toBe(1);
    expect(f.totalPods).toBe(1);
    expect(f.podNames).toEqual(["api-1"]);
    expect(f.issues).toEqual([]);
    expect(f.health).toBe("ok");
  });

  it("broken link: Ingress → missing service", () => {
    const flows = computeFlows(
      [ingress("web", "default", [{ host: "x.io", service: "nonexistent-svc" }])],
      [],
      [],
    );
    expect(flows).toHaveLength(1);
    const f = flows[0];
    expect(f.serviceName).toBe("nonexistent-svc");
    expect(f.namespace).toBe("default");
    expect(f.serviceExists).toBe(false);
    expect(f.serviceType).toBe("—");
    expect(f.isExternal).toBe(true);
    expect(f.readyPods).toBe(0);
    expect(f.totalPods).toBe(0);
    expect(f.issues).toEqual(["Ingress points to a service that doesn't exist"]);
    expect(f.health).toBe("broken");
  });

  it("degraded: external service with pods but none ready → broken", () => {
    const flows = computeFlows(
      [ingress("web", "default", [{ host: "x.io", service: "api" }])],
      [service("api", "default", { app: "api" })],
      [
        pod("api-1", "default", { app: "api" }, { ready: [false] }),
        pod("api-2", "default", { app: "api" }, { phase: "Pending" }),
      ],
    );
    expect(flows).toHaveLength(1);
    const f = flows[0];
    expect(f.totalPods).toBe(2);
    expect(f.readyPods).toBe(0);
    expect(f.issues).toEqual(["2 pods, 0 ready"]);
    expect(f.health).toBe("broken"); // external + issues
  });

  it("degraded internal service (no ingress) with 0 ready → warn", () => {
    const flows = computeFlows(
      [],
      [service("db", "default", { app: "db" })],
      [pod("db-1", "default", { app: "db" }, { ready: [false] })],
    );
    expect(flows).toHaveLength(1);
    expect(flows[0].issues).toEqual(["1 pod, 0 ready"]);
    expect(flows[0].health).toBe("warn");
  });

  it("selector matches no pods → issue", () => {
    const flows = computeFlows([], [service("db", "default", { app: "db" })], []);
    expect(flows[0].issues).toEqual(["Selector matches no pods"]);
    expect(flows[0].health).toBe("warn");
    expect(flows[0].totalPods).toBe(0);
  });

  it("internal-only flow: service not exposed via ingress, healthy", () => {
    const flows = computeFlows(
      [],
      [service("db", "default", { app: "db" })],
      [pod("db-1", "default", { app: "db" })],
    );
    expect(flows).toHaveLength(1);
    expect(flows[0].isExternal).toBe(false);
    expect(flows[0].hosts).toEqual([]);
    expect(flows[0].ingressNames).toEqual([]);
    expect(flows[0].health).toBe("ok");
  });

  it("multiple ingresses → same service: hosts + ingressNames merged and sorted", () => {
    const flows = computeFlows(
      [
        ingress("ing-b", "default", [{ host: "zeta.io", service: "api" }]),
        ingress("ing-a", "default", [{ host: "alpha.io", service: "api" }]),
      ],
      [service("api", "default", { app: "api" })],
      [pod("api-1", "default", { app: "api" })],
    );
    expect(flows).toHaveLength(1);
    expect(flows[0].hosts).toEqual(["alpha.io", "zeta.io"]);
    expect(flows[0].ingressNames).toEqual(["ing-a", "ing-b"]);
  });

  it("namespace isolation: same service name in two namespaces → two flows", () => {
    const flows = computeFlows(
      [],
      [service("api", "default", { app: "api" }), service("api", "prod", { app: "api" })],
      [
        pod("api-d", "default", { app: "api" }),
        pod("api-p", "prod", { app: "api" }),
      ],
    );
    expect(flows).toHaveLength(2);
    const byNs = Object.fromEntries(flows.map((f) => [f.namespace, f]));
    expect(byNs.default.id).toBe("default/api");
    expect(byNs.default.podNames).toEqual(["api-d"]);
    expect(byNs.prod.id).toBe("prod/api");
    expect(byNs.prod.podNames).toEqual(["api-p"]);
  });

  it("no-selector service: no pods matched, no issues", () => {
    const flows = computeFlows(
      [],
      [service("ext", "default", undefined, "ExternalName")],
      [pod("p", "default", { app: "anything" })],
    );
    expect(flows).toHaveLength(1);
    expect(flows[0].totalPods).toBe(0);
    expect(flows[0].issues).toEqual([]);
    expect(flows[0].health).toBe("ok");
    expect(flows[0].serviceType).toBe("ExternalName");
  });

  it("ingress with host='*' (no host) tracks external but adds no host chip", () => {
    const flows = computeFlows(
      [ingress("web", "default", [{ service: "api" }])], // no host
      [service("api", "default", { app: "api" })],
      [pod("api-1", "default", { app: "api" })],
    );
    expect(flows[0].isExternal).toBe(true);
    expect(flows[0].hosts).toEqual([]);
    expect(flows[0].ingressNames).toEqual(["web"]);
  });

  it("ingress with no rules emits no front (no dangling flow)", () => {
    const ing: Ingress = { metadata: { name: "empty", namespace: "default", uid: "e" }, spec: {} };
    const flows = computeFlows([ing], [], []);
    expect(flows).toEqual([]);
  });

  it("selector matches only same-namespace pods", () => {
    const flows = computeFlows(
      [],
      [service("api", "default", { app: "api" })],
      [pod("api-other", "prod", { app: "api" })], // wrong namespace
    );
    expect(flows[0].totalPods).toBe(0);
    expect(flows[0].issues).toEqual(["Selector matches no pods"]);
  });

  it("empty cluster → empty flows", () => {
    expect(computeFlows([], [], [])).toEqual([]);
  });

  it("sort order: broken < warn < ok, then namespace, then name", () => {
    const flows = computeFlows(
      [ingress("ing", "default", [{ host: "x.io", service: "broken-svc" }])], // dangling → broken
      [
        service("ok-b", "ns2", { app: "ok-b" }),
        service("ok-a", "ns1", { app: "ok-a" }),
        service("warn-svc", "default", { app: "warn" }), // internal, no pods → warn
      ],
      [
        pod("a", "ns1", { app: "ok-a" }),
        pod("b", "ns2", { app: "ok-b" }),
      ],
    );
    expect(flows.map((f) => f.id)).toEqual([
      "default/broken-svc", // broken
      "default/warn-svc", // warn
      "ns1/ok-a", // ok, ns1
      "ns2/ok-b", // ok, ns2
    ]);
  });
});
