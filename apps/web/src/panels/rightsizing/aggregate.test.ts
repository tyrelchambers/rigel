import { describe, test, expect } from "vitest";
import {
  containerResources,
  podBelongsTo,
  windowStatsFromUsage,
  buildRightSizing,
  type UsageRow,
  type WorkloadObject,
} from "./aggregate";

const MiB = 1024 * 1024;

describe("containerResources", () => {
  test("parses requests/limits into cores/bytes", () => {
    const r = containerResources({
      name: "web",
      resources: {
        requests: { cpu: "250m", memory: "256Mi" },
        limits: { cpu: "1", memory: "1Gi" },
      },
    });
    expect(r).toEqual({
      container: "web",
      cpuRequest: 0.25,
      cpuLimit: 1,
      memRequest: 256 * MiB,
      memLimit: 1024 * MiB,
    });
  });
  test("missing values → undefined", () => {
    const r = containerResources({ name: "web" });
    expect(r.cpuRequest).toBeUndefined();
    expect(r.memLimit).toBeUndefined();
  });
});

describe("podBelongsTo", () => {
  test("matches <name>-* and exact", () => {
    expect(podBelongsTo("web-abc123", "web")).toBe(true);
    expect(podBelongsTo("web", "web")).toBe(true);
    expect(podBelongsTo("webhook-1", "web")).toBe(false);
    expect(podBelongsTo("api-x", "web")).toBe(false);
  });
});

describe("buildRightSizing", () => {
  const dep: WorkloadObject = {
    metadata: { name: "web", namespace: "default" },
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: "web",
              resources: {
                requests: { cpu: "250m", memory: "256Mi" },
                limits: { cpu: "500m", memory: "512Mi" },
              },
            },
          ],
        },
      },
    },
  };

  test("builds one row per workload with verdicts", () => {
    const byKind = { deployments: { web: dep } };
    // No usage rows → empty stats → insufficient data
    const rows = buildRightSizing(byKind, (ns, w, c) => windowStatsFromUsage([], ns, w, c));
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("deployment");
    expect(rows[0].name).toBe("web");
    expect(rows[0].worst).toBe("insufficientData");
  });

  test("skips workloads with no containers", () => {
    const byKind = {
      deployments: { empty: { metadata: { name: "empty", namespace: "default" } } },
    };
    expect(buildRightSizing(byKind, (ns, w, c) => windowStatsFromUsage([], ns, w, c))).toHaveLength(0);
  });
});

describe("windowStatsFromUsage", () => {
  const rows: UsageRow[] = [
    { namespace: "default", pod: "web-1", container: "web", cpuPeak: 0.4, cpuTypical: 0.2, memPeak: 200 * MiB, memTypical: 120 * MiB, hoursCovered: 720 },
    { namespace: "default", pod: "web-2", container: "web", cpuPeak: 0.6, cpuTypical: 0.3, memPeak: 180 * MiB, memTypical: 100 * MiB, hoursCovered: 700 },
    { namespace: "default", pod: "api-1", container: "api", cpuPeak: 0.1, cpuTypical: 0.05, memPeak: 64 * MiB, memTypical: 32 * MiB, hoursCovered: 720 },
  ];

  test("takes the worst-case across the workload's pods (max)", () => {
    const ws = windowStatsFromUsage(rows, "default", "web", "web");
    expect(ws.cpuPeak).toBeCloseTo(0.6);
    expect(ws.cpuTypical).toBeCloseTo(0.3);
    expect(ws.memPeak).toBe(200 * MiB);
    expect(ws.memTypical).toBe(120 * MiB);
    expect(ws.hoursCovered).toBe(720);
  });

  test("matches pods by the <name>-* convention and ignores other workloads", () => {
    const ws = windowStatsFromUsage(rows, "default", "web", "web");
    // api-1 must not bleed into web's stats
    expect(ws.memPeak).toBe(200 * MiB);
  });

  test("no matching pods → empty stats (hoursCovered 0)", () => {
    expect(windowStatsFromUsage(rows, "default", "redis", "redis").hoursCovered).toBe(0);
  });
});
