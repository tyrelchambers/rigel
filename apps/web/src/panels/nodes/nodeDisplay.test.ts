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
