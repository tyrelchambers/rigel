import { describe, test, expect } from "vitest";
import {
  analyzeContainer,
  reclaimableMemBytes,
  summarizeWorkload,
  parseQuantity,
  formatCpuCores,
  formatMemBytes,
  cpuToString,
  memToString,
  quantityToString,
  suggestionYaml,
  suggestionQuantities,
  sortWorkloads,
  matchesSearch,
  worstVerdict,
} from "./displayHelper";
import type { ContainerResources, WindowStats, WorkloadRightSizing } from "./types";

const MiB = 1024 * 1024;
const GiB = 1024 * 1024 * 1024;

function stats(p: Partial<WindowStats>): WindowStats {
  return {
    container: "c",
    cpuPeak: 0,
    cpuTypical: 0,
    memPeak: 0,
    memTypical: 0,
    hoursCovered: 48,
    ...p,
  };
}
function res(p: Partial<ContainerResources>): ContainerResources {
  return { container: "c", ...p };
}

// --- Quantity parsing -------------------------------------------------------

describe("parseQuantity", () => {
  test("CPU strings → cores", () => {
    expect(parseQuantity("1500m", "cpu")).toBe(1.5);
    expect(parseQuantity("4", "cpu")).toBe(4);
    expect(parseQuantity("250m", "cpu")).toBe(0.25);
  });
  test("memory strings → bytes", () => {
    expect(parseQuantity("512Mi", "memory")).toBe(536870912);
    expect(parseQuantity("1Gi", "memory")).toBe(1073741824);
    expect(parseQuantity("512Ki", "memory")).toBe(524288);
  });
  test("malformed → 0", () => {
    expect(parseQuantity("", "cpu")).toBe(0);
    expect(parseQuantity("nonsense", "memory")).toBe(0);
  });
});

// --- Display formatting -----------------------------------------------------

describe("formatCpuCores", () => {
  test("<1 core → millicores", () => {
    expect(formatCpuCores(0.25)).toBe("250m");
    expect(formatCpuCores(0.05)).toBe("50m");
  });
  test("1..<10 → 2 decimals", () => {
    expect(formatCpuCores(2.5)).toBe("2.50");
    expect(formatCpuCores(1)).toBe("1.00");
  });
  test("≥10 → integer", () => {
    expect(formatCpuCores(12)).toBe("12");
    expect(formatCpuCores(40.4)).toBe("40");
  });
});

describe("formatMemBytes", () => {
  test("binary units, 1 decimal <10, 0 decimals ≥10", () => {
    expect(formatMemBytes(1.5 * GiB)).toBe("1.5 GiB");
    expect(formatMemBytes(256 * MiB)).toBe("256 MiB");
    expect(formatMemBytes(2 * GiB)).toBe("2.0 GiB");
    expect(formatMemBytes(12 * GiB)).toBe("12 GiB");
  });
});

// --- Quantity generation (kubectl strings) ----------------------------------

describe("cpuToString / memToString", () => {
  test("CPU rounds up to 10m, collapses whole cores", () => {
    expect(cpuToString(0.25)).toBe("250m");
    expect(cpuToString(2.0)).toBe("2");
    expect(cpuToString(0.251)).toBe("260m"); // round up to nearest 10m
    expect(cpuToString(1)).toBe("1");
  });
  test("memory rounds up to MiB, collapses GiB", () => {
    expect(memToString(320 * MiB)).toBe("320Mi");
    expect(memToString(2 * GiB)).toBe("2Gi");
    expect(memToString(320 * MiB + 1)).toBe("321Mi"); // round up
  });
  test("quantityToString dispatches", () => {
    expect(quantityToString(0.25, "cpu")).toBe("250m");
    expect(quantityToString(2 * GiB, "memory")).toBe("2Gi");
  });
});

// --- Verdict logic ----------------------------------------------------------

describe("analyzeContainer verdicts", () => {
  test("insufficient data when hoursCovered < 24", () => {
    const r = analyzeContainer(res({}), stats({ hoursCovered: 5 }));
    expect(r.verdict).toBe("insufficientData");
    expect(r.rationale).toContain("5h");
    expect(r.suggestedCpuRequest).toBeUndefined();
  });

  test("at-risk: memory peak ≥ 90% of limit", () => {
    const r = analyzeContainer(
      res({ cpuRequest: 0.1, cpuLimit: 1, memRequest: 100 * MiB, memLimit: 100 * MiB }),
      stats({ memPeak: 95 * MiB, memTypical: 50 * MiB, cpuPeak: 0.2, cpuTypical: 0.1 }),
    );
    expect(r.verdict).toBe("atRisk");
    expect(r.rationale).toContain("OOM");
  });

  test("at-risk: cpu peak ≥ 95% of limit", () => {
    const r = analyzeContainer(
      res({ cpuRequest: 0.1, cpuLimit: 1, memRequest: 100 * MiB, memLimit: 1 * GiB }),
      stats({ cpuPeak: 0.96, cpuTypical: 0.3, memPeak: 100 * MiB, memTypical: 50 * MiB }),
    );
    expect(r.verdict).toBe("atRisk");
    expect(r.rationale).toContain("throttling");
  });

  test("unset: missing any request/limit", () => {
    const r = analyzeContainer(
      res({ cpuRequest: 0.1, cpuLimit: 1, memRequest: 100 * MiB /* memLimit missing */ }),
      stats({ cpuPeak: 0.2, cpuTypical: 0.1, memPeak: 50 * MiB, memTypical: 30 * MiB }),
    );
    expect(r.verdict).toBe("unset");
  });

  test("over-provisioned: memory request > 2× typical and slack > 128MiB", () => {
    const r = analyzeContainer(
      res({ cpuRequest: 0.2, cpuLimit: 1, memRequest: 1 * GiB, memLimit: 2 * GiB }),
      stats({ memPeak: 300 * MiB, memTypical: 200 * MiB, cpuPeak: 0.3, cpuTypical: 0.15 }),
    );
    expect(r.verdict).toBe("overProvisioned");
  });

  test("over-provisioned: cpu request > 3× typical and slack > 100m", () => {
    const r = analyzeContainer(
      res({ cpuRequest: 1, cpuLimit: 2, memRequest: 200 * MiB, memLimit: 400 * MiB }),
      stats({ cpuPeak: 0.4, cpuTypical: 0.2, memPeak: 150 * MiB, memTypical: 120 * MiB }),
    );
    expect(r.verdict).toBe("overProvisioned");
  });

  test("ok: tracks usage", () => {
    const r = analyzeContainer(
      res({ cpuRequest: 0.25, cpuLimit: 0.5, memRequest: 256 * MiB, memLimit: 512 * MiB }),
      stats({ cpuPeak: 0.3, cpuTypical: 0.2, memPeak: 300 * MiB, memTypical: 220 * MiB }),
    );
    expect(r.verdict).toBe("ok");
  });

  test("verdict precedence: at-risk wins over over-provisioned", () => {
    // memory hugely over-provisioned by request, but CPU peak at limit → atRisk first
    const r = analyzeContainer(
      res({ cpuRequest: 0.1, cpuLimit: 1, memRequest: 4 * GiB, memLimit: 8 * GiB }),
      stats({ cpuPeak: 0.99, cpuTypical: 0.1, memPeak: 200 * MiB, memTypical: 100 * MiB }),
    );
    expect(r.verdict).toBe("atRisk");
  });

  test("suggestions: requests=max(typical,min), limits=max(peak×headroom,request)", () => {
    const r = analyzeContainer(
      res({ cpuRequest: 0.25, cpuLimit: 0.5, memRequest: 256 * MiB, memLimit: 512 * MiB }),
      stats({ cpuPeak: 0.4, cpuTypical: 0.2, memPeak: 300 * MiB, memTypical: 220 * MiB }),
    );
    expect(r.suggestedCpuRequest).toBeCloseTo(0.2);
    expect(r.suggestedMemRequest).toBe(220 * MiB);
    expect(r.suggestedCpuLimit).toBeCloseTo(0.4 * 1.5);
    expect(r.suggestedMemLimit).toBe(300 * MiB * 1.2);
  });
});

// --- Reclaimable + summary --------------------------------------------------

describe("reclaimable + summary", () => {
  test("reclaimable only for over-provisioned", () => {
    const over = analyzeContainer(
      res({ cpuRequest: 0.2, cpuLimit: 1, memRequest: 1 * GiB, memLimit: 2 * GiB }),
      stats({ memPeak: 300 * MiB, memTypical: 200 * MiB, cpuPeak: 0.3, cpuTypical: 0.15 }),
    );
    expect(reclaimableMemBytes(over)).toBe(1 * GiB - 200 * MiB);

    const ok = analyzeContainer(
      res({ cpuRequest: 0.25, cpuLimit: 0.5, memRequest: 256 * MiB, memLimit: 512 * MiB }),
      stats({ cpuPeak: 0.3, cpuTypical: 0.2, memPeak: 300 * MiB, memTypical: 220 * MiB }),
    );
    expect(reclaimableMemBytes(ok)).toBe(0);
  });

  test("summarizeWorkload picks worst verdict + sums reclaim", () => {
    const ok = analyzeContainer(
      res({ container: "a", cpuRequest: 0.25, cpuLimit: 0.5, memRequest: 256 * MiB, memLimit: 512 * MiB }),
      stats({ container: "a", cpuPeak: 0.3, cpuTypical: 0.2, memPeak: 300 * MiB, memTypical: 220 * MiB }),
    );
    const over = analyzeContainer(
      res({ container: "b", cpuRequest: 0.2, cpuLimit: 1, memRequest: 1 * GiB, memLimit: 2 * GiB }),
      stats({ container: "b", memPeak: 300 * MiB, memTypical: 200 * MiB, cpuPeak: 0.3, cpuTypical: 0.15 }),
    );
    const w = summarizeWorkload("deployment", "web", "default", [ok, over]);
    expect(w.worst).toBe("overProvisioned");
    expect(w.reclaimableMemBytes).toBe(1 * GiB - 200 * MiB);
  });

  test("worstVerdict ordering", () => {
    expect(worstVerdict("ok", "atRisk")).toBe("atRisk");
    expect(worstVerdict("unset", "overProvisioned")).toBe("unset");
    expect(worstVerdict("ok", "insufficientData")).toBe("ok");
  });
});

// --- Sorting + search -------------------------------------------------------

function wl(p: Partial<WorkloadRightSizing>): WorkloadRightSizing {
  return {
    kind: "deployment",
    name: "x",
    namespace: "default",
    containers: [],
    worst: "ok",
    reclaimableMemBytes: 0,
    ...p,
  };
}

describe("sortWorkloads", () => {
  const a = wl({ name: "alpha", namespace: "ns-a", worst: "ok", reclaimableMemBytes: 10 });
  const b = wl({ name: "bravo", namespace: "ns-a", worst: "atRisk", reclaimableMemBytes: 0 });
  const c = wl({ name: "charlie", namespace: "ns-b", worst: "unset", reclaimableMemBytes: 0 });
  const d = wl({ name: "delta", namespace: "ns-a", worst: "overProvisioned", reclaimableMemBytes: 500 });

  test("needs-attention: atRisk, unset, over, ok; ns/name within tier", () => {
    const sorted = sortWorkloads([a, b, c, d], "needs-attention");
    expect(sorted.map((w) => w.worst)).toEqual([
      "atRisk",
      "unset",
      "overProvisioned",
      "ok",
    ]);
  });

  test("wasteful: reclaimable desc", () => {
    const sorted = sortWorkloads([a, b, c, d], "wasteful");
    expect(sorted.map((w) => w.reclaimableMemBytes)).toEqual([500, 10, 0, 0]);
  });

  test("name: ns then name", () => {
    const sorted = sortWorkloads([c, a, d, b], "name");
    expect(sorted.map((w) => w.name)).toEqual(["alpha", "bravo", "delta", "charlie"]);
  });
});

describe("matchesSearch", () => {
  const w = wl({ name: "postgres", namespace: "databases" });
  test("matches name or namespace, case-insensitive", () => {
    expect(matchesSearch(w, "POST")).toBe(true);
    expect(matchesSearch(w, "datab")).toBe(true);
    expect(matchesSearch(w, "")).toBe(true);
    expect(matchesSearch(w, "redis")).toBe(false);
  });
});

// --- YAML + quantities ------------------------------------------------------

describe("suggestion output", () => {
  const r = analyzeContainer(
    res({ cpuRequest: 0.25, cpuLimit: 0.5, memRequest: 256 * MiB, memLimit: 512 * MiB }),
    stats({ cpuPeak: 0.4, cpuTypical: 0.2, memPeak: 300 * MiB, memTypical: 220 * MiB }),
  );
  test("YAML snippet has requests/limits with kubectl quantities", () => {
    const yaml = suggestionYaml(r);
    expect(yaml).toContain("requests:");
    expect(yaml).toContain("limits:");
    expect(yaml).toContain("cpu: 200m");
    expect(yaml).toContain("memory: 220Mi");
  });
  test("suggestionQuantities builds --requests/--limits values", () => {
    const q = suggestionQuantities(r);
    expect(q.requests).toBe("cpu=200m,memory=220Mi");
    // 0.4 × 1.5 cores, rounded UP to the nearest 10m (fp noise can push to 610m).
    expect(q.limits).toMatch(/^cpu=6[01]0m,memory=\d+Mi$/);
  });
});
