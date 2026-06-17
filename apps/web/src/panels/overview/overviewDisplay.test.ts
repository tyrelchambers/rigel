import { describe, expect, test } from "vitest";
import type { Deployment, Node, NodeMetrics, Pod } from "./types";
import {
  phaseCounts,
  deploymentHealth,
  unhealthyDeploymentCount,
  nodeReadyCount,
  nodePressureCount,
  parseCpuQuantity,
  parseMemQuantity,
  formatCpu,
  formatBytes,
  clusterResourceTotals,
  perNodeResourceTotals,
  metricsAvailable,
} from "./overviewDisplay";

function pod(phase?: string): Pod {
  return {
    metadata: { name: "p", uid: "u" },
    spec: { containers: [] },
    status: phase ? { phase } : {},
  };
}

function deployment(spec?: Deployment["spec"], status?: Deployment["status"]): Deployment {
  return { metadata: { name: "d" }, spec, status };
}

function node(overrides: Partial<Node> = {}): Node {
  return {
    metadata: { name: overrides.metadata?.name ?? "worker-1", ...overrides.metadata },
    spec: overrides.spec,
    status: overrides.status,
  };
}

describe("perNodeResourceTotals", () => {
  test("one entry per node, sorted by name, with per-node usage + fractions", () => {
    const nodes = [
      node({ metadata: { name: "n2" }, status: { allocatable: { cpu: "4", memory: "8Gi" } } }),
      node({ metadata: { name: "n1" }, status: { allocatable: { cpu: "2", memory: "4Gi" } } }),
    ];
    const metrics = {
      n1: { metadata: { name: "n1" }, usage: { cpu: "1", memory: "2Gi" } },
      n2: { metadata: { name: "n2" }, usage: { cpu: "2", memory: "4Gi" } },
    };
    const rows = perNodeResourceTotals(nodes, metrics);
    expect(rows.map((r) => r.name)).toEqual(["n1", "n2"]); // sorted
    expect(rows[0].cpuFraction).toBeCloseTo(0.5); // n1: 1/2
    expect(rows[0].memFraction).toBeCloseTo(0.5); // n1: 2Gi/4Gi
    expect(rows[1].cpuFraction).toBeCloseTo(0.5); // n2: 2/4
  });

  test("node without metrics → usage 0, fraction 0, allocatable still parsed", () => {
    const rows = perNodeResourceTotals([node({ metadata: { name: "n1" }, status: { allocatable: { cpu: "4", memory: "8Gi" } } })], {});
    expect(rows[0].cpuUsed).toBe(0);
    expect(rows[0].cpuFraction).toBe(0);
    expect(rows[0].cpuAllocatable).toBe(4);
  });

  test("fractions clamp to [0,1] when usage exceeds allocatable", () => {
    const rows = perNodeResourceTotals(
      [node({ metadata: { name: "n1" }, status: { allocatable: { cpu: "1", memory: "1Gi" } } })],
      { n1: { metadata: { name: "n1" }, usage: { cpu: "4", memory: "4Gi" } } },
    );
    expect(rows[0].cpuFraction).toBe(1);
    expect(rows[0].memFraction).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// phaseCounts
// ---------------------------------------------------------------------------

describe("phaseCounts", () => {
  test("empty array maps to all zeros", () => {
    expect(phaseCounts([])).toEqual({ running: 0, pending: 0, failed: 0, other: 0 });
  });

  test("counts mixed phases correctly", () => {
    expect(
      phaseCounts([
        pod("Running"),
        pod("Running"),
        pod("Pending"),
        pod("Failed"),
        pod("Unknown"),
      ]),
    ).toEqual({ running: 2, pending: 1, failed: 1, other: 1 });
  });

  test("Succeeded counts as running", () => {
    expect(phaseCounts([pod("Succeeded"), pod("Running")])).toEqual({
      running: 2,
      pending: 0,
      failed: 0,
      other: 0,
    });
  });

  test("missing phase counts as other", () => {
    expect(phaseCounts([pod(undefined)])).toEqual({
      running: 0,
      pending: 0,
      failed: 0,
      other: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// deploymentHealth
// ---------------------------------------------------------------------------

describe("deploymentHealth", () => {
  test("desired 0 is healthy even with ready 0", () => {
    expect(deploymentHealth(deployment({ replicas: 0 }, { readyReplicas: 0 }))).toBe(true);
  });

  test("ready equals desired is healthy", () => {
    expect(deploymentHealth(deployment({ replicas: 3 }, { readyReplicas: 3 }))).toBe(true);
  });

  test("ready exceeds desired is healthy", () => {
    expect(deploymentHealth(deployment({ replicas: 1 }, { readyReplicas: 2 }))).toBe(true);
  });

  test("ready below desired with desired > 0 is unhealthy", () => {
    expect(deploymentHealth(deployment({ replicas: 3 }, { readyReplicas: 1 }))).toBe(false);
  });

  test("falls back to status.replicas when spec.replicas missing", () => {
    expect(deploymentHealth(deployment(undefined, { replicas: 2, readyReplicas: 1 }))).toBe(false);
  });

  test("missing status.replicas treated as 0 (healthy)", () => {
    expect(deploymentHealth(deployment(undefined, {}))).toBe(true);
    expect(deploymentHealth(deployment(undefined, undefined))).toBe(true);
  });

  test("unhealthyDeploymentCount sums the degraded ones", () => {
    expect(
      unhealthyDeploymentCount([
        deployment({ replicas: 3 }, { readyReplicas: 3 }), // healthy
        deployment({ replicas: 3 }, { readyReplicas: 1 }), // unhealthy
        deployment({ replicas: 0 }, { readyReplicas: 0 }), // healthy
        deployment({ replicas: 2 }, { readyReplicas: 0 }), // unhealthy
      ]),
    ).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// nodeReadyCount
// ---------------------------------------------------------------------------

describe("nodeReadyCount", () => {
  test("all ready", () => {
    const nodes = [
      node({ status: { conditions: [{ type: "Ready", status: "True" }] } }),
      node({ status: { conditions: [{ type: "Ready", status: "True" }] } }),
    ];
    expect(nodeReadyCount(nodes)).toEqual({ ready: 2, total: 2 });
  });

  test("some ready", () => {
    const nodes = [
      node({ status: { conditions: [{ type: "Ready", status: "True" }] } }),
      node({ status: { conditions: [{ type: "Ready", status: "False" }] } }),
      node({ status: { conditions: [{ type: "Ready", status: "Unknown" }] } }),
    ];
    expect(nodeReadyCount(nodes)).toEqual({ ready: 1, total: 3 });
  });

  test("no conditions or no status is not ready", () => {
    expect(nodeReadyCount([node({ status: { conditions: [] } }), node({})])).toEqual({
      ready: 0,
      total: 2,
    });
  });

  test("empty maps to 0/0", () => {
    expect(nodeReadyCount([])).toEqual({ ready: 0, total: 0 });
  });
});

// ---------------------------------------------------------------------------
// nodePressureCount
// ---------------------------------------------------------------------------

describe("nodePressureCount", () => {
  test("only Ready condition yields 0 pressure", () => {
    expect(
      nodePressureCount([node({ status: { conditions: [{ type: "Ready", status: "True" }] } })]),
    ).toBe(0);
  });

  test("single active pressure condition counts 1", () => {
    expect(
      nodePressureCount([
        node({
          status: {
            conditions: [
              { type: "Ready", status: "True" },
              { type: "DiskPressure", status: "True" },
            ],
          },
        }),
      ]),
    ).toBe(1);
  });

  test("inactive pressure (status False) does not count", () => {
    expect(
      nodePressureCount([
        node({ status: { conditions: [{ type: "DiskPressure", status: "False" }] } }),
      ]),
    ).toBe(0);
  });

  test("sums multiple pressure conditions across nodes", () => {
    expect(
      nodePressureCount([
        node({
          status: {
            conditions: [
              { type: "DiskPressure", status: "True" },
              { type: "MemoryPressure", status: "True" },
            ],
          },
        }),
        node({
          status: {
            conditions: [{ type: "PIDPressure", status: "True" }],
          },
        }),
      ]),
    ).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// parseCpuQuantity / parseMemQuantity
// ---------------------------------------------------------------------------

describe("parseCpuQuantity", () => {
  test("plain cores", () => {
    expect(parseCpuQuantity("2")).toBe(2);
    expect(parseCpuQuantity("1.5")).toBe(1.5);
  });
  test("millicores", () => {
    expect(parseCpuQuantity("500m")).toBeCloseTo(0.5);
  });
  test("nanocores", () => {
    expect(parseCpuQuantity("450000000n")).toBeCloseTo(0.45);
  });
  test("missing or unparseable maps to 0", () => {
    expect(parseCpuQuantity(undefined)).toBe(0);
    expect(parseCpuQuantity("")).toBe(0);
    expect(parseCpuQuantity("abc")).toBe(0);
  });
});

describe("parseMemQuantity", () => {
  test("binary-SI", () => {
    expect(parseMemQuantity("8192Mi")).toBe(8192 * 2 ** 20);
    expect(parseMemQuantity("1Gi")).toBe(2 ** 30);
  });
  test("plain bytes", () => {
    expect(parseMemQuantity("8589934592")).toBe(8589934592);
  });
  test("decimal-SI", () => {
    expect(parseMemQuantity("1G")).toBe(1e9);
  });
  test("missing or unparseable maps to 0", () => {
    expect(parseMemQuantity(undefined)).toBe(0);
    expect(parseMemQuantity("xyz")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// formatCpu
// ---------------------------------------------------------------------------

describe("formatCpu", () => {
  test("0 maps to '0'", () => {
    expect(formatCpu(0)).toBe("0");
  });
  test("below 1 core renders as millicores", () => {
    expect(formatCpu(0.45)).toBe("450m");
    expect(formatCpu(0.5)).toBe("500m");
  });
  test("1 core or more renders with one decimal", () => {
    expect(formatCpu(4.5)).toBe("4.5");
    expect(formatCpu(16)).toBe("16.0");
  });
});

// ---------------------------------------------------------------------------
// formatBytes
// ---------------------------------------------------------------------------

describe("formatBytes", () => {
  test("8192Mi maps to 8Gi", () => {
    expect(formatBytes("8192Mi")).toBe("8Gi");
  });
  test("1024Ki maps to 1Mi", () => {
    expect(formatBytes("1024Ki")).toBe("1Mi");
  });
  test("0 maps to '0'", () => {
    expect(formatBytes("0")).toBe("0");
  });
  test("undefined maps to em dash", () => {
    expect(formatBytes(undefined)).toBe("—");
  });
  test("invalid format maps to em dash", () => {
    expect(formatBytes("not-a-quantity")).toBe("—");
    expect(formatBytes("8Xy")).toBe("—");
  });
});

// ---------------------------------------------------------------------------
// clusterResourceTotals
// ---------------------------------------------------------------------------

describe("clusterResourceTotals", () => {
  test("empty nodes maps to all zeros", () => {
    const t = clusterResourceTotals([], {});
    expect(t.cpuAllocatable).toBe(0);
    expect(t.memAllocatable).toBe(0);
    expect(t.cpuUsed).toBe(0);
    expect(t.memUsed).toBe(0);
    expect(t.cpuFraction).toBe(0);
    expect(t.memFraction).toBe(0);
  });

  test("nodes without metrics keep usage at 0 but sum allocatable", () => {
    const nodes = [
      node({ status: { allocatable: { cpu: "4", memory: "8Gi" } } }),
      node({
        metadata: { name: "worker-2" },
        status: { allocatable: { cpu: "4", memory: "8Gi" } },
      }),
    ];
    const t = clusterResourceTotals(nodes, {});
    expect(t.cpuAllocatable).toBe(8);
    expect(t.memAllocatable).toBe(16 * 2 ** 30);
    expect(t.cpuUsed).toBe(0);
    expect(t.memUsed).toBe(0);
  });

  test("allocatable falls back to capacity when allocatable missing", () => {
    const nodes = [node({ status: { capacity: { cpu: "2", memory: "4Gi" } } })];
    const t = clusterResourceTotals(nodes, {});
    expect(t.cpuAllocatable).toBe(2);
    expect(t.memAllocatable).toBe(4 * 2 ** 30);
  });

  test("sums usage from metrics keyed by node name", () => {
    const nodes = [
      node({ metadata: { name: "n1" }, status: { allocatable: { cpu: "4", memory: "8Gi" } } }),
      node({ metadata: { name: "n2" }, status: { allocatable: { cpu: "4", memory: "8Gi" } } }),
    ];
    const metrics: Record<string, NodeMetrics> = {
      n1: { metadata: { name: "n1" }, usage: { cpu: "1", memory: "2Gi" } },
      n2: { metadata: { name: "n2" }, usage: { cpu: "1", memory: "2Gi" } },
    };
    const t = clusterResourceTotals(nodes, metrics);
    expect(t.cpuUsed).toBe(2);
    expect(t.memUsed).toBe(4 * 2 ** 30);
    expect(t.cpuFraction).toBeCloseTo(2 / 8);
    expect(t.memFraction).toBeCloseTo(4 / 16);
  });

  test("fractions clamp to [0, 1] when usage exceeds allocatable", () => {
    const nodes = [node({ metadata: { name: "n1" }, status: { allocatable: { cpu: "1", memory: "1Gi" } } })];
    const metrics: Record<string, NodeMetrics> = {
      n1: { metadata: { name: "n1" }, usage: { cpu: "4", memory: "4Gi" } },
    };
    const t = clusterResourceTotals(nodes, metrics);
    expect(t.cpuFraction).toBe(1);
    expect(t.memFraction).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// metricsAvailable
// ---------------------------------------------------------------------------

describe("metricsAvailable", () => {
  test("false when no metrics samples", () => {
    expect(metricsAvailable({})).toBe(false);
  });
  test("true when at least one sample present", () => {
    expect(metricsAvailable({ n1: { metadata: { name: "n1" }, usage: {} } })).toBe(true);
  });
});
