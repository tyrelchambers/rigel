import { describe, expect, test } from "vitest";
import type { Node } from "./types";
import {
  isReady,
  role,
  isCordoned,
  internalIP,
  pressureConditions,
  formatCpu,
  formatBytes,
  capacityValue,
  parseCpuCores,
  parseBytes,
  formatCoresValue,
  formatBytesValue,
  usageColor,
  matchesSearch,
  sortNodes,
} from "./nodeDisplay";

function node(overrides: Partial<Node> = {}): Node {
  return {
    metadata: { name: "worker-1", uid: "u1", ...overrides.metadata },
    spec: overrides.spec,
    status: overrides.status,
  };
}

describe("isReady", () => {
  test("true when Ready condition status is True", () => {
    expect(
      isReady(node({ status: { conditions: [{ type: "Ready", status: "True" }] } })),
    ).toBe(true);
  });
  test("false when Ready condition is not True", () => {
    expect(
      isReady(node({ status: { conditions: [{ type: "Ready", status: "False" }] } })),
    ).toBe(false);
    expect(
      isReady(node({ status: { conditions: [{ type: "Ready", status: "Unknown" }] } })),
    ).toBe(false);
  });
  test("false when no Ready condition / no conditions / no status", () => {
    expect(isReady(node({ status: { conditions: [{ type: "DiskPressure", status: "False" }] } }))).toBe(false);
    expect(isReady(node({ status: { conditions: [] } }))).toBe(false);
    expect(isReady(node())).toBe(false);
  });
});

describe("role", () => {
  test("control-plane when control-plane label present", () => {
    expect(
      role(node({ metadata: { name: "cp", labels: { "node-role.kubernetes.io/control-plane": "" } } })),
    ).toBe("control-plane");
  });
  test("control-plane when legacy master label present", () => {
    expect(
      role(node({ metadata: { name: "cp", labels: { "node-role.kubernetes.io/master": "" } } })),
    ).toBe("control-plane");
  });
  test("worker by default", () => {
    expect(role(node({ metadata: { name: "w", labels: { foo: "bar" } } }))).toBe("worker");
    expect(role(node())).toBe("worker");
  });
});

describe("isCordoned", () => {
  test("true only when spec.unschedulable is true", () => {
    expect(isCordoned(node({ spec: { unschedulable: true } }))).toBe(true);
    expect(isCordoned(node({ spec: { unschedulable: false } }))).toBe(false);
    expect(isCordoned(node({ spec: {} }))).toBe(false);
    expect(isCordoned(node())).toBe(false);
  });
});

describe("internalIP", () => {
  test("returns the InternalIP address", () => {
    expect(
      internalIP(
        node({
          status: {
            addresses: [
              { type: "Hostname", address: "worker-1" },
              { type: "InternalIP", address: "10.0.0.5" },
            ],
          },
        }),
      ),
    ).toBe("10.0.0.5");
  });
  test("dash when no InternalIP", () => {
    expect(internalIP(node({ status: { addresses: [{ type: "Hostname", address: "w" }] } }))).toBe("—");
    expect(internalIP(node())).toBe("—");
  });
});

describe("pressureConditions", () => {
  test("returns non-Ready conditions whose status is True", () => {
    const n = node({
      status: {
        conditions: [
          { type: "Ready", status: "True" },
          { type: "DiskPressure", status: "True", message: "low disk" },
          { type: "MemoryPressure", status: "False" },
          { type: "PIDPressure", status: "True" },
        ],
      },
    });
    const out = pressureConditions(n);
    expect(out.map((c) => c.type)).toEqual(["DiskPressure", "PIDPressure"]);
  });
  test("ignores a Ready=True and empty when none active", () => {
    expect(pressureConditions(node({ status: { conditions: [{ type: "Ready", status: "True" }] } }))).toEqual([]);
    expect(pressureConditions(node())).toEqual([]);
  });
});

describe("formatCpu", () => {
  test("integer cores pass through; millicores preserved", () => {
    expect(formatCpu("2")).toBe("2");
    expect(formatCpu("500m")).toBe("500m");
  });
  test("dash for missing", () => {
    expect(formatCpu(undefined)).toBe("—");
  });
});

describe("formatBytes", () => {
  test("Ki/Mi/Gi quantities collapse to a clean human size", () => {
    expect(formatBytes("8192Mi")).toBe("8Gi");
    expect(formatBytes("512Mi")).toBe("512Mi");
    expect(formatBytes("1048576Ki")).toBe("1Gi");
  });
  test("plain byte counts format too", () => {
    expect(formatBytes("1073741824")).toBe("1Gi");
  });
  test("dash for missing or unparseable", () => {
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes("not-a-qty")).toBe("—");
  });
});

describe("capacityValue", () => {
  test("reads a capacity key, dash when absent", () => {
    const n = node({ status: { capacity: { cpu: "4", pods: "110" } } });
    expect(capacityValue(n, "cpu")).toBe("4");
    expect(capacityValue(n, "pods")).toBe("110");
    expect(capacityValue(n, "ephemeral-storage")).toBe(undefined);
    expect(capacityValue(node(), "cpu")).toBe(undefined);
  });
});

describe("matchesSearch", () => {
  const n = node({
    metadata: {
      name: "worker-prod-1",
      uid: "u1",
      labels: { "kubernetes.io/arch": "amd64", tier: "edge" },
    },
  });
  test("empty/blank query matches everything", () => {
    expect(matchesSearch(n, "")).toBe(true);
    expect(matchesSearch(n, "   ")).toBe(true);
  });
  test("case-insensitive match on name, label key and value", () => {
    expect(matchesSearch(n, "PROD")).toBe(true); // name
    expect(matchesSearch(n, "arch")).toBe(true); // label key
    expect(matchesSearch(n, "amd64")).toBe(true); // label value
    expect(matchesSearch(n, "EDGE")).toBe(true); // label value
  });
  test("no match returns false", () => {
    expect(matchesSearch(n, "control-plane")).toBe(false);
  });
});

describe("parseCpuCores", () => {
  test("plain cores, milli, micro, nano", () => {
    expect(parseCpuCores("4")).toBe(4);
    expect(parseCpuCores("1500m")).toBeCloseTo(1.5);
    expect(parseCpuCores("908m")).toBeCloseTo(0.908);
    expect(parseCpuCores("1500000n")).toBeCloseTo(0.0015);
    expect(parseCpuCores(undefined)).toBe(0);
    expect(parseCpuCores("")).toBe(0);
  });
});

describe("parseBytes", () => {
  test("binary and decimal suffixes", () => {
    expect(parseBytes("1Gi")).toBe(1024 ** 3);
    expect(parseBytes("512Mi")).toBe(512 * 1024 ** 2);
    expect(parseBytes("1G")).toBe(1e9);
    expect(parseBytes("2048")).toBe(2048);
    expect(parseBytes(undefined)).toBe(0);
  });
});

describe("formatCoresValue", () => {
  test("sub-core shows millicores; <10 two decimals; >=10 integer", () => {
    expect(formatCoresValue(0.908)).toBe("908 m");
    expect(formatCoresValue(1.49)).toBe("1.49");
    expect(formatCoresValue(8)).toBe("8.00");
    expect(formatCoresValue(12)).toBe("12");
  });
});

describe("formatBytesValue", () => {
  test("GiB with space; >=10 integer, <10 one decimal", () => {
    expect(formatBytesValue(9.8 * 1024 ** 3)).toBe("9.8 GiB");
    expect(formatBytesValue(19 * 1024 ** 3)).toBe("19 GiB");
    expect(formatBytesValue(368109502464)).toBe("343 GiB");
    expect(formatBytesValue(512 * 1024 ** 2)).toBe("512 MiB");
  });
});

describe("usageColor", () => {
  test("thresholds: green <70%, amber <90%, red else; grey without metrics", () => {
    expect(usageColor(0.5, true)).toBe("#10B981");
    expect(usageColor(0.8, true)).toBe("#F59E0B");
    expect(usageColor(0.95, true)).toBe("#EF4444");
    expect(usageColor(0.95, false)).toBe("#34353A");
  });
});

describe("sortNodes", () => {
  test("control-plane first, then by name lexicographically", () => {
    const w2 = node({ metadata: { name: "worker-2", uid: "1" } });
    const cpB = node({ metadata: { name: "cp-b", uid: "2", labels: { "node-role.kubernetes.io/control-plane": "" } } });
    const w1 = node({ metadata: { name: "worker-1", uid: "3" } });
    const cpA = node({ metadata: { name: "cp-a", uid: "4", labels: { "node-role.kubernetes.io/master": "" } } });
    const sorted = sortNodes([w2, cpB, w1, cpA]).map((n) => n.metadata.name);
    expect(sorted).toEqual(["cp-a", "cp-b", "worker-1", "worker-2"]);
  });
});
