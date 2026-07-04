import { describe, it, expect } from "vitest";
import {
  detectAllBackendsFromServices,
  pickBackend,
  proxyBase,
  promEncode,
  parsePromInstant,
  seriesToNodeMap,
  nodeCpuPercentQuery,
  nodeMemoryPercentQuery,
} from "./prometheus";

describe("detectAllBackendsFromServices", () => {
  it("recognizes the rigel-metrics install service by port", () => {
    const b = detectAllBackendsFromServices([
      { metadata: { name: "rigel-metrics", namespace: "rigel-metrics" }, spec: { ports: [{ port: 8428 }] } },
    ]);
    expect(b).toEqual([{ namespace: "rigel-metrics", service: "rigel-metrics", port: 8428, flavor: "VictoriaMetrics" }]);
  });
});

describe("pickBackend", () => {
  it("prefers the installed rigel-metrics service", () => {
    const chosen = pickBackend([
      { namespace: "x", service: "prometheus", port: 9090, flavor: "Prometheus" },
      { namespace: "m", service: "rigel-metrics", port: 8428, flavor: "VictoriaMetrics" },
    ]);
    expect(chosen?.service).toBe("rigel-metrics");
  });
});

describe("proxyBase + promEncode", () => {
  it("builds the API-server service-proxy path", () => {
    expect(proxyBase({ namespace: "ns", service: "svc", port: 8428, flavor: "VictoriaMetrics" }))
      .toBe("/api/v1/namespaces/ns/services/svc:8428/proxy");
  });
  it("percent-encodes reserved PromQL chars", () => {
    expect(promEncode("a b")).toBe("a%20b");
  });
});

describe("node percent query builders", () => {
  it("memory query has no node filter when node omitted", () => {
    expect(nodeMemoryPercentQuery()).toBe(
      '100 * max by (kubernetes_io_hostname) (container_memory_working_set_bytes{id="/"}) / max by (kubernetes_io_hostname) (machine_memory_bytes)',
    );
  });
  it("cpu query filters by hostname when node given", () => {
    expect(nodeCpuPercentQuery("node-a")).toBe(
      '100 * sum by (kubernetes_io_hostname) (rate(container_cpu_usage_seconds_total{id="/",kubernetes_io_hostname="node-a"}[5m])) / max by (kubernetes_io_hostname) (machine_cpu_cores{kubernetes_io_hostname="node-a"})',
    );
  });
});

describe("seriesToNodeMap", () => {
  it("maps hostname → numeric percent, dropping non-finite values", () => {
    const map = seriesToNodeMap([
      { metric: { kubernetes_io_hostname: "node-a" }, value: [0, "91.5"] },
      { metric: { kubernetes_io_hostname: "node-b" }, value: [0, "NaN"] },
      { metric: {}, value: [0, "50"] },
    ]);
    expect(map).toEqual({ "node-a": 91.5 });
  });
});

describe("parsePromInstant", () => {
  it("returns [] on a non-success payload", () => {
    expect(parsePromInstant('{"status":"error"}')).toEqual([]);
  });
});
