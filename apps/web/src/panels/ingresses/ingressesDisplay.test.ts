import { describe, expect, test } from "vitest";
import type { Ingress } from "./types";
import {
  className,
  isTLS,
  hosts,
  portLabel,
  flattenRoutes,
  externalAddress,
  matchesSearch,
  sortIngresses,
} from "./ingressesDisplay";

function ingress(overrides: Partial<Ingress> = {}): Ingress {
  return {
    metadata: { name: "ing", namespace: "default", uid: "u1", ...overrides.metadata },
    spec: overrides.spec,
    status: overrides.status,
  };
}

describe("className", () => {
  test("returns spec.ingressClassName", () => {
    expect(className(ingress({ spec: { ingressClassName: "nginx" } }))).toBe("nginx");
  });
  test("dash when nil", () => {
    expect(className(ingress())).toBe("—");
  });
  test("dash when empty string", () => {
    expect(className(ingress({ spec: { ingressClassName: "" } }))).toBe("—");
  });
});

describe("isTLS", () => {
  test("false when no tls", () => {
    expect(isTLS(ingress())).toBe(false);
    expect(isTLS(ingress({ spec: { tls: [] } }))).toBe(false);
  });
  test("true when tls non-empty", () => {
    expect(isTLS(ingress({ spec: { tls: [{ secretName: "s" }] } }))).toBe(true);
  });
});

describe("hosts", () => {
  test("empty when no rules", () => {
    expect(hosts(ingress())).toEqual([]);
  });
  test("unique and sorted", () => {
    expect(
      hosts(
        ingress({
          spec: {
            rules: [
              { host: "b.example.com" },
              { host: "a.example.com" },
              { host: "b.example.com" },
            ],
          },
        }),
      ),
    ).toEqual(["a.example.com", "b.example.com"]);
  });
  test("skips rules without a host", () => {
    expect(hosts(ingress({ spec: { rules: [{ host: "x.com" }, {}] } }))).toEqual(["x.com"]);
  });
});

describe("portLabel", () => {
  test("number wins", () => {
    expect(portLabel({ number: 8080, name: "http" })).toBe("8080");
  });
  test("falls back to name", () => {
    expect(portLabel({ name: "http" })).toBe("http");
  });
  test("empty when nothing", () => {
    expect(portLabel(undefined)).toBe("");
    expect(portLabel({})).toBe("");
  });
});

describe("flattenRoutes", () => {
  test("flattens rules into host/path/service/port tuples", () => {
    const ing = ingress({
      spec: {
        rules: [
          {
            host: "example.com",
            http: {
              paths: [
                { path: "/api", backend: { service: { name: "api-service", port: { number: 8080 } } } },
                { path: "/static", backend: { service: { name: "static-service", port: { number: 80 } } } },
              ],
            },
          },
          {
            host: "api.example.com",
            http: {
              paths: [{ path: "/", backend: { service: { name: "backend-service", port: { number: 3000 } } } }],
            },
          },
        ],
      },
    });
    expect(flattenRoutes(ing)).toEqual([
      { host: "example.com", path: "/api", service: "api-service", port: "8080" },
      { host: "example.com", path: "/static", service: "static-service", port: "80" },
      { host: "api.example.com", path: "/", service: "backend-service", port: "3000" },
    ]);
  });
  test("defaults host to * and path to /", () => {
    const ing = ingress({
      spec: { rules: [{ http: { paths: [{ backend: { service: { name: "svc", port: { number: 80 } } } }] } }] },
    });
    expect(flattenRoutes(ing)).toEqual([{ host: "*", path: "/", service: "svc", port: "80" }]);
  });
  test("service '—' when missing", () => {
    const ing = ingress({
      spec: { rules: [{ host: "x.com", http: { paths: [{ path: "/", backend: {} }] } }] },
    });
    expect(flattenRoutes(ing)).toEqual([{ host: "x.com", path: "/", service: "—", port: "" }]);
  });
  test("includes default backend as host=*, path=/", () => {
    const ing = ingress({
      spec: {
        rules: [
          { host: "x.com", http: { paths: [{ path: "/", backend: { service: { name: "a", port: { number: 80 } } } }] } },
        ],
        defaultBackend: { service: { name: "fallback-service", port: { number: 80 } } },
      },
    });
    expect(flattenRoutes(ing)).toEqual([
      { host: "x.com", path: "/", service: "a", port: "80" },
      { host: "*", path: "/", service: "fallback-service", port: "80" },
    ]);
  });
  test("empty when no rules and no default backend", () => {
    expect(flattenRoutes(ingress())).toEqual([]);
  });
  test("named port surfaces in route", () => {
    const ing = ingress({
      spec: { rules: [{ host: "x.com", http: { paths: [{ path: "/", backend: { service: { name: "a", port: { name: "web" } } } }] } }] },
    });
    expect(flattenRoutes(ing)[0].port).toBe("web");
  });
});

describe("externalAddress", () => {
  test("ip preferred over hostname per entry", () => {
    expect(
      externalAddress(
        ingress({ status: { loadBalancer: { ingress: [{ ip: "203.0.113.45", hostname: "lb.example.com" }] } } }),
      ),
    ).toBe("203.0.113.45");
  });
  test("hostname used when no ip", () => {
    expect(
      externalAddress(ingress({ status: { loadBalancer: { ingress: [{ hostname: "lb.example.com" }] } } })),
    ).toBe("lb.example.com");
  });
  test("multiple addresses joined by comma", () => {
    expect(
      externalAddress(
        ingress({ status: { loadBalancer: { ingress: [{ ip: "203.0.113.45" }, { hostname: "lb.example.com" }] } } }),
      ),
    ).toBe("203.0.113.45, lb.example.com");
  });
  test("null when none assigned", () => {
    expect(externalAddress(ingress())).toBeNull();
    expect(externalAddress(ingress({ status: { loadBalancer: { ingress: [] } } }))).toBeNull();
    expect(externalAddress(ingress({ status: { loadBalancer: { ingress: [{}] } } }))).toBeNull();
  });
});

describe("matchesSearch", () => {
  const ing = ingress({
    metadata: { name: "web-ingress", namespace: "shop", uid: "u1" },
    spec: {
      ingressClassName: "nginx",
      rules: [
        { host: "shop.example.com", http: { paths: [{ path: "/", backend: { service: { name: "frontend-svc", port: { number: 80 } } } }] } },
      ],
    },
  });
  test("blank matches all", () => {
    expect(matchesSearch(ing, "")).toBe(true);
    expect(matchesSearch(ing, "   ")).toBe(true);
  });
  test("matches name", () => {
    expect(matchesSearch(ing, "WEB-ING")).toBe(true);
  });
  test("matches namespace", () => {
    expect(matchesSearch(ing, "shop")).toBe(true);
  });
  test("matches class", () => {
    expect(matchesSearch(ing, "NGINX")).toBe(true);
  });
  test("matches host", () => {
    expect(matchesSearch(ing, "shop.example")).toBe(true);
  });
  test("matches backend service name", () => {
    expect(matchesSearch(ing, "frontend-svc")).toBe(true);
  });
  test("no match returns false", () => {
    expect(matchesSearch(ing, "zzz")).toBe(false);
  });
});

describe("sortIngresses", () => {
  test("by namespace then name, stable", () => {
    const list = [
      ingress({ metadata: { name: "b", namespace: "ns2", uid: "1" } }),
      ingress({ metadata: { name: "a", namespace: "ns2", uid: "2" } }),
      ingress({ metadata: { name: "z", namespace: "ns1", uid: "3" } }),
    ];
    expect(sortIngresses(list).map((i) => `${i.metadata.namespace}/${i.metadata.name}`)).toEqual([
      "ns1/z",
      "ns2/a",
      "ns2/b",
    ]);
  });
});
