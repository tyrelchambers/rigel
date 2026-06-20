import { test, expect, describe } from "vitest";
import {
  detectBackendFromServices,
  proxyBase,
  promEncode,
  usageQueries,
  parsePromInstant,
  mergeUsage,
  type PromSeries,
} from "./prometheusMetrics";

const svc = (name: string, namespace: string, ports: Array<{ name?: string; port: number }>) => ({
  metadata: { name, namespace },
  spec: { ports },
});

describe("detectBackendFromServices", () => {
  test("recognizes the Rigel-installed rigel-metrics service (VM port)", () => {
    const b = detectBackendFromServices([svc("rigel-metrics", "rigel-metrics", [{ name: "http", port: 8428 }])]);
    expect(b).toEqual({ namespace: "rigel-metrics", service: "rigel-metrics", port: 8428, flavor: "VictoriaMetrics" });
  });

  test("recognizes rigel-metrics on the Prometheus port", () => {
    const b = detectBackendFromServices([svc("rigel-metrics", "obs", [{ port: 9090 }])]);
    expect(b?.flavor).toBe("Prometheus");
    expect(b?.port).toBe(9090);
  });

  test("detects a generic VictoriaMetrics single-node by name + port", () => {
    const b = detectBackendFromServices([svc("vmsingle-foo", "monitoring", [{ port: 8428 }])]);
    expect(b).toEqual({ namespace: "monitoring", service: "vmsingle-foo", port: 8428, flavor: "VictoriaMetrics" });
  });

  test("detects Prometheus by name on :9090", () => {
    const b = detectBackendFromServices([svc("kube-prometheus-stack-prometheus", "monitoring", [{ port: 9090 }])]);
    expect(b?.flavor).toBe("Prometheus");
  });

  test("skips operators, exporters, alertmanager and kube-state", () => {
    const b = detectBackendFromServices([
      svc("prometheus-operator", "monitoring", [{ port: 9090 }]),
      svc("node-exporter", "monitoring", [{ port: 9100 }]),
      svc("alertmanager", "monitoring", [{ port: 9093 }]),
      svc("kube-state-metrics", "monitoring", [{ port: 8080 }]),
    ]);
    expect(b).toBeNull();
  });

  test("prefers the Rigel-installed backend over a pre-existing stack", () => {
    const b = detectBackendFromServices([
      svc("kube-prometheus-stack-prometheus", "monitoring", [{ port: 9090 }]),
      svc("rigel-metrics", "rigel-metrics", [{ port: 8428 }]),
    ]);
    expect(b?.service).toBe("rigel-metrics");
  });

  test("returns null when nothing matches", () => {
    expect(detectBackendFromServices([svc("redis", "default", [{ port: 6379 }])])).toBeNull();
  });
});

test("proxyBase builds the API-server services proxy path", () => {
  expect(proxyBase({ namespace: "rigel-metrics", service: "rigel-metrics", port: 8428, flavor: "VictoriaMetrics" })).toBe(
    "/api/v1/namespaces/rigel-metrics/services/rigel-metrics:8428/proxy",
  );
});

test("promEncode percent-encodes all non-alphanumerics", () => {
  expect(promEncode("a (b)")).toBe("a%20%28b%29");
  // PromQL reserved chars must all be encoded.
  expect(promEncode('x{y="z"}')).toBe("x%7By%3D%22z%22%7D");
});

describe("usageQueries", () => {
  test("scopes to a namespace when one is given", () => {
    const qs = usageQueries("default");
    expect(qs).toHaveLength(5);
    expect(qs[0]).toContain('namespace="default"');
    expect(qs[0]).toContain("max_over_time(container_memory_working_set_bytes");
    expect(qs[2]).toContain("rate(container_cpu_usage_seconds_total");
  });

  test("omits the namespace label for the all-namespaces case", () => {
    expect(usageQueries("*")[0]).not.toContain("namespace=");
  });
});

test("parsePromInstant returns [] for non-success / garbage", () => {
  expect(parsePromInstant('{"status":"error"}')).toEqual([]);
  expect(parsePromInstant("not json")).toEqual([]);
});

describe("mergeUsage", () => {
  const s = (ns: string, pod: string, container: string, v: number): PromSeries => ({
    metric: { namespace: ns, pod, container },
    value: [0, String(v)],
  });

  test("folds the five queries into one row per pod/container", () => {
    const rows = mergeUsage(
      {
        memPeak: [s("default", "web-1", "web", 200)],
        memTypical: [s("default", "web-1", "web", 120)],
        cpuPeak: [s("default", "web-1", "web", 0.5)],
        cpuTypical: [s("default", "web-1", "web", 0.2)],
        count: [s("default", "web-1", "web", 43200)], // 43200 × 60s / 3600 = 720h
      },
      60,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      namespace: "default",
      pod: "web-1",
      container: "web",
      memPeak: 200,
      memTypical: 120,
      cpuPeak: 0.5,
      cpuTypical: 0.2,
      hoursCovered: 720,
    });
  });

  test("drops series missing the required labels", () => {
    const rows = mergeUsage(
      { memPeak: [{ metric: { pod: "x", container: "c" }, value: [0, "1"] }], memTypical: [], cpuPeak: [], cpuTypical: [], count: [] },
      60,
    );
    expect(rows).toEqual([]);
  });
});
