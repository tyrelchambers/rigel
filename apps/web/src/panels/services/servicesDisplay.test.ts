import { describe, expect, test } from "vitest";
import type { Service, ServicePort } from "./types";
import type { Pod } from "../pods/types";
import {
  typeLabel,
  isExternalName,
  portSummary,
  portSummaries,
  externalAddress,
  endpointCount,
  matchesSearch,
  sortServices,
  humanAge,
} from "./servicesDisplay";

function service(overrides: Partial<Service> = {}): Service {
  return {
    metadata: { name: "svc", namespace: "default", uid: "u1", ...overrides.metadata },
    spec: overrides.spec,
    status: overrides.status,
  };
}

function pod(name: string, namespace: string, labels: Record<string, string>): Pod {
  return {
    metadata: { name, namespace, uid: name, labels },
    spec: { containers: [] },
  };
}

describe("typeLabel / isExternalName", () => {
  test("defaults to ClusterIP", () => {
    expect(typeLabel(service())).toBe("ClusterIP");
  });
  test("returns spec.type", () => {
    expect(typeLabel(service({ spec: { type: "LoadBalancer" } }))).toBe("LoadBalancer");
  });
  test("isExternalName only for ExternalName", () => {
    expect(isExternalName(service({ spec: { type: "ExternalName" } }))).toBe(true);
    expect(isExternalName(service({ spec: { type: "ClusterIP" } }))).toBe(false);
    expect(isExternalName(service())).toBe(false);
  });
});

describe("portSummary", () => {
  test("plain port defaults protocol to TCP", () => {
    expect(portSummary({ port: 443 } as ServicePort)).toBe("443/TCP");
  });
  test("uses provided protocol", () => {
    expect(portSummary({ port: 53, protocol: "UDP" } as ServicePort)).toBe("53/UDP");
  });
  test("targetPort differing from port adds arrow", () => {
    expect(portSummary({ port: 80, targetPort: 8080 } as ServicePort)).toBe("80→8080/TCP");
  });
  test("targetPort equal to port (numeric vs string) omits arrow", () => {
    expect(portSummary({ port: 80, targetPort: 80 } as ServicePort)).toBe("80/TCP");
    expect(portSummary({ port: 80, targetPort: "80" } as ServicePort)).toBe("80/TCP");
  });
  test("named targetPort always shows arrow", () => {
    expect(portSummary({ port: 80, targetPort: "http" } as ServicePort)).toBe("80→http/TCP");
  });
  test("nodePort prefixes head; full form", () => {
    expect(
      portSummary({ port: 8080, nodePort: 30080, targetPort: 9090, protocol: "TCP" } as ServicePort),
    ).toBe("8080:30080→9090/TCP");
  });
  test("nodePort without differing targetPort", () => {
    expect(portSummary({ port: 80, nodePort: 30080 } as ServicePort)).toBe("80:30080/TCP");
  });
});

describe("portSummaries", () => {
  test("empty/undefined ports -> empty array", () => {
    expect(portSummaries(undefined)).toEqual([]);
    expect(portSummaries([])).toEqual([]);
  });
  test("maps every port", () => {
    expect(
      portSummaries([
        { port: 80, targetPort: 8080 },
        { port: 443 },
      ] as ServicePort[]),
    ).toEqual(["80→8080/TCP", "443/TCP"]);
  });
});

describe("externalAddress", () => {
  test("LoadBalancer ingress wins (ip then hostname)", () => {
    expect(
      externalAddress(
        service({
          status: { loadBalancer: { ingress: [{ ip: "203.0.113.45" }, { hostname: "lb.example.com" }] } },
          spec: { externalIPs: ["10.0.0.1"], externalName: "x.com" },
        }),
      ),
    ).toBe("203.0.113.45, lb.example.com");
  });
  test("falls back to externalIPs", () => {
    expect(
      externalAddress(service({ spec: { externalIPs: ["10.0.0.1", "10.0.0.2"], externalName: "x.com" } })),
    ).toBe("10.0.0.1, 10.0.0.2");
  });
  test("falls back to externalName", () => {
    expect(externalAddress(service({ spec: { externalName: "db.example.com" } }))).toBe("db.example.com");
  });
  test("null when nothing present", () => {
    expect(externalAddress(service())).toBeNull();
    expect(externalAddress(service({ status: { loadBalancer: { ingress: [] } } }))).toBeNull();
  });
});

describe("endpointCount", () => {
  test("null when no selector", () => {
    expect(endpointCount(service(), [])).toBeNull();
    expect(endpointCount(service({ spec: { selector: {} } }), [])).toBeNull();
  });
  test("counts pods matching selector in same namespace", () => {
    const svc = service({ spec: { selector: { app: "web" } } });
    const pods = [
      pod("a", "default", { app: "web", tier: "frontend" }),
      pod("b", "default", { app: "web" }),
      pod("c", "default", { app: "api" }),
      pod("d", "other", { app: "web" }),
    ];
    expect(endpointCount(svc, pods)).toBe(2);
  });
  test("requires all selector keys to match", () => {
    const svc = service({ spec: { selector: { app: "web", tier: "frontend" } } });
    const pods = [
      pod("a", "default", { app: "web", tier: "frontend" }),
      pod("b", "default", { app: "web" }),
    ];
    expect(endpointCount(svc, pods)).toBe(1);
  });
  test("zero when no pods match", () => {
    const svc = service({ spec: { selector: { app: "web" } } });
    expect(endpointCount(svc, [pod("a", "default", { app: "api" })])).toBe(0);
  });
});

describe("matchesSearch", () => {
  const svc = service({
    metadata: { name: "frontend", namespace: "shop", uid: "u1" },
    spec: { type: "LoadBalancer", clusterIP: "10.96.0.7", selector: { app: "web" }, ports: [{ port: 80, targetPort: 8080 }] },
  });
  test("blank matches all", () => {
    expect(matchesSearch(svc, "")).toBe(true);
    expect(matchesSearch(svc, "   ")).toBe(true);
  });
  test("matches name / namespace / type case-insensitively", () => {
    expect(matchesSearch(svc, "FRONT")).toBe(true);
    expect(matchesSearch(svc, "shop")).toBe(true);
    expect(matchesSearch(svc, "loadbalancer")).toBe(true);
  });
  test("matches clusterIP", () => {
    expect(matchesSearch(svc, "10.96")).toBe(true);
  });
  test("matches formatted port summary", () => {
    expect(matchesSearch(svc, "80→8080")).toBe(true);
    expect(matchesSearch(svc, "8080")).toBe(true);
  });
  test("matches selector key=value", () => {
    expect(matchesSearch(svc, "app=web")).toBe(true);
  });
  test("no match returns false", () => {
    expect(matchesSearch(svc, "zzz")).toBe(false);
  });
});

describe("sortServices", () => {
  test("by namespace then name, stable", () => {
    const services = [
      service({ metadata: { name: "b", namespace: "ns2", uid: "1" } }),
      service({ metadata: { name: "a", namespace: "ns2", uid: "2" } }),
      service({ metadata: { name: "z", namespace: "ns1", uid: "3" } }),
    ];
    expect(sortServices(services).map((s) => `${s.metadata.namespace}/${s.metadata.name}`)).toEqual([
      "ns1/z",
      "ns2/a",
      "ns2/b",
    ]);
  });
});

const NOW = 1_700_000_000_000;
describe("humanAge", () => {
  test("days plural / singular", () => {
    expect(humanAge(new Date(NOW - 165 * 86400_000).toISOString(), NOW)).toBe("165 days");
    expect(humanAge(new Date(NOW - 1 * 86400_000).toISOString(), NOW)).toBe("1 day");
  });
  test("hours and minutes", () => {
    expect(humanAge(new Date(NOW - 3 * 3600_000).toISOString(), NOW)).toBe("3 hours");
    expect(humanAge(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("5 minutes");
  });
  test("just now and missing", () => {
    expect(humanAge(new Date(NOW - 10_000).toISOString(), NOW)).toBe("just now");
    expect(humanAge(undefined, NOW)).toBe("—");
  });
});
