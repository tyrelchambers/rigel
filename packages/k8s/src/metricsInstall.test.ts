import { describe, test, expect } from "vitest";
import {
  renderMetricsInstallManifest,
  resultingBackend,
  metricsBackendPort,
  namespaceValid,
  METRICS_SERVICE_NAME,
} from "./metricsInstall";

describe("metricsBackendPort / resultingBackend", () => {
  test("VictoriaMetrics → 8428, Prometheus → 9090", () => {
    expect(metricsBackendPort("victoriaMetrics")).toBe(8428);
    expect(metricsBackendPort("prometheus")).toBe(9090);
  });
  test("resultingBackend points at the install service", () => {
    expect(resultingBackend("victoriaMetrics", "rigel-metrics")).toEqual({
      namespace: "rigel-metrics",
      service: METRICS_SERVICE_NAME,
      port: 8428,
      flavor: "VictoriaMetrics",
    });
  });
});

describe("namespaceValid", () => {
  test("accepts RFC-1123 labels, rejects junk", () => {
    expect(namespaceValid("rigel-metrics")).toBe(true);
    expect(namespaceValid("monitoring")).toBe(true);
    expect(namespaceValid("-bad")).toBe(false);
    expect(namespaceValid("Bad_NS")).toBe(false);
    expect(namespaceValid("")).toBe(false);
  });
});

describe("renderMetricsInstallManifest (VictoriaMetrics)", () => {
  const yaml = renderMetricsInstallManifest("victoriaMetrics", "rigel-metrics", true, 5);

  test("renders the expected resources", () => {
    expect(yaml).toContain("kind: Namespace");
    expect(yaml).toContain("kind: ServiceAccount");
    expect(yaml).toContain("kind: ClusterRoleBinding");
    expect(yaml).toContain("kind: ConfigMap");
    expect(yaml).toContain("kind: Deployment");
    expect(yaml).toContain("kind: Service");
    expect(yaml).toContain("kind: PersistentVolumeClaim");
  });

  test("uses the VM image, port 8428 and the rigel-metrics service", () => {
    expect(yaml).toContain("victoriametrics/victoria-metrics:");
    expect(yaml).toContain("-httpListenAddr=:8428");
    expect(yaml).toContain("port: 8428");
    expect(yaml).toContain(`name: ${METRICS_SERVICE_NAME}`);
  });

  test("keeps the literal relabel reference ${1} (not interpolated)", () => {
    expect(yaml).toContain("/api/v1/nodes/${1}/proxy/metrics/cadvisor");
  });

  test("persistent → PVC of the requested size; ephemeral → emptyDir", () => {
    expect(yaml).toContain("storage: 5Gi");
    expect(yaml).toContain("claimName: rigel-metrics");
    const ephemeral = renderMetricsInstallManifest("victoriaMetrics", "rigel-metrics", false, 5);
    expect(ephemeral).toContain("emptyDir: {}");
    expect(ephemeral).not.toContain("kind: PersistentVolumeClaim");
  });
});

test("renderMetricsInstallManifest (Prometheus) uses :9090 + 30d retention", () => {
  const yaml = renderMetricsInstallManifest("prometheus", "monitoring", false, 5);
  expect(yaml).toContain("prom/prometheus:");
  expect(yaml).toContain("--web.listen-address=:9090");
  expect(yaml).toContain("--storage.tsdb.retention.time=30d");
  expect(yaml).toContain("port: 9090");
  expect(yaml).toContain("namespace: monitoring");
});
