import { describe, it, expect, vi } from "vitest";
import {
  usageQueries,
  mergeUsage,
  podBelongsTo,
  windowStatsFromUsage,
  fetchUsage,
  type UsageRow,
} from "./usage";
import type { PromBackend, PromSeries as UsagePromSeries } from "./prometheus";

const MiB = 1024 * 1024;

describe("usageQueries", () => {
  it("scopes to a namespace when one is given", () => {
    const qs = usageQueries("default");
    expect(qs).toHaveLength(5);
    expect(qs[0]).toContain('namespace="default"');
    expect(qs[0]).toContain("max_over_time(container_memory_working_set_bytes");
    expect(qs[2]).toContain("rate(container_cpu_usage_seconds_total");
  });

  it("omits the namespace label for the all-namespaces case", () => {
    expect(usageQueries("*")[0]).not.toContain("namespace=");
  });
});

describe("mergeUsage", () => {
  const s = (ns: string, pod: string, container: string, v: number) => ({
    metric: { namespace: ns, pod, container },
    value: [0, String(v)] as [number, string],
  });

  it("folds the five queries into one row per pod/container", () => {
    const rows = mergeUsage(
      {
        memPeak: [s("default", "web-1", "web", 200)],
        memTypical: [s("default", "web-1", "web", 120)],
        cpuPeak: [s("default", "web-1", "web", 0.5)],
        cpuTypical: [s("default", "web-1", "web", 0.2)],
        count: [s("default", "web-1", "web", 43200)], // 43200 x 60s / 3600 = 720h
      },
      60,
    );
    expect(rows).toEqual([
      { namespace: "default", pod: "web-1", container: "web", memPeak: 200, memTypical: 120, cpuPeak: 0.5, cpuTypical: 0.2, hoursCovered: 720 },
    ]);
  });

  it("drops series missing required labels", () => {
    const rows = mergeUsage(
      { memPeak: [{ metric: { pod: "x", container: "c" }, value: [0, "1"] }], memTypical: [], cpuPeak: [], cpuTypical: [], count: [] },
      60,
    );
    expect(rows).toEqual([]);
  });
});

describe("podBelongsTo", () => {
  it("matches <name>-* and exact", () => {
    expect(podBelongsTo("web-abc123", "web")).toBe(true);
    expect(podBelongsTo("web", "web")).toBe(true);
    expect(podBelongsTo("webhook-1", "web")).toBe(false);
  });
});

describe("windowStatsFromUsage", () => {
  const rows: UsageRow[] = [
    { namespace: "default", pod: "web-1", container: "web", cpuPeak: 0.4, cpuTypical: 0.2, memPeak: 200 * MiB, memTypical: 120 * MiB, hoursCovered: 720 },
    { namespace: "default", pod: "web-2", container: "web", cpuPeak: 0.6, cpuTypical: 0.3, memPeak: 180 * MiB, memTypical: 100 * MiB, hoursCovered: 700 },
  ];

  it("takes the worst-case (max) across the workload's pods", () => {
    const ws = windowStatsFromUsage(rows, "default", "web", "web");
    expect(ws.cpuPeak).toBeCloseTo(0.6);
    expect(ws.memPeak).toBe(200 * MiB);
    expect(ws.hoursCovered).toBe(720);
  });

  it("no matching pods -> empty stats (hoursCovered 0)", () => {
    expect(windowStatsFromUsage(rows, "default", "redis", "redis").hoursCovered).toBe(0);
  });
});

describe("fetchUsage", () => {
  const backend: PromBackend = { namespace: "rigel-metrics", service: "rigel-metrics", port: 8428, flavor: "VictoriaMetrics" };

  function seriesPayload(series: UsagePromSeries[]): string {
    return JSON.stringify({ status: "success", data: { result: series } });
  }

  it("runs 5 --raw instant queries through the proxy and merges the rows", async () => {
    const calls: string[][] = [];
    // usageQueries() returns [memPeak, memTypical, cpuPeak, cpuTypical, count] in
    // that order, and fetchUsage maps + Promise.all's them — the mock's
    // synchronous push (before its first await) preserves that call order.
    const runner = vi.fn(async (args: string[]) => {
      const index = calls.length;
      calls.push(args);
      if (index === 0) {
        return seriesPayload([{ metric: { namespace: "default", pod: "web-1", container: "web" }, value: [0, "200000000"] }]);
      }
      return seriesPayload([]);
    });
    const rows = await fetchUsage(runner, backend, "default");
    expect(calls).toHaveLength(5);
    expect(calls[0][0]).toBe("get");
    expect(calls[0][1]).toBe("--raw");
    expect(calls[0][2]).toContain("/api/v1/namespaces/rigel-metrics/services/rigel-metrics:8428/proxy/api/v1/query?query=");
    expect(rows).toEqual([
      { namespace: "default", pod: "web-1", container: "web", cpuPeak: 0, cpuTypical: 0, memPeak: 200000000, memTypical: 0, hoursCovered: 0 },
    ]);
  });

  it("a failing individual query degrades to empty rather than throwing", async () => {
    const runner = vi.fn(async () => {
      throw new Error("kubectl get --raw failed");
    });
    const rows = await fetchUsage(runner, backend, "*");
    expect(rows).toEqual([]);
  });
});
