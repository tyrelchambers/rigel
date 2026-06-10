import { describe, test, expect } from "vitest";
import {
  containerResources,
  podBelongsTo,
  ingestSamples,
  windowStatsFor,
  buildRightSizing,
  type PodMetric,
  type SampleStore,
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

describe("ingest + windowStats", () => {
  const metrics: PodMetric[] = [
    { namespace: "default", name: "web-1", cpu: "100", memory: "100Mi" },
    { namespace: "default", name: "web-2", cpu: "200", memory: "150Mi" },
    { namespace: "default", name: "api-1", cpu: "50", memory: "64Mi" },
  ];

  test("sums pod metrics per workload into one sample", () => {
    const store: SampleStore = new Map();
    ingestSamples(store, metrics, [{ namespace: "default", name: "web" }], 0);
    const stats = windowStatsFor(store, "default", "web", "web");
    // cpu: (100+200)/1000 cores; mem: (100+150)Mi
    expect(stats.cpuPeak).toBeCloseTo(0.3);
    expect(stats.memPeak).toBe(250 * MiB);
    expect(stats.hoursCovered).toBe(1);
  });

  test("hoursCovered counts distinct hour buckets", () => {
    const store: SampleStore = new Map();
    const hour = 60 * 60 * 1000;
    ingestSamples(store, metrics, [{ namespace: "default", name: "web" }], 0);
    ingestSamples(store, metrics, [{ namespace: "default", name: "web" }], hour);
    ingestSamples(store, metrics, [{ namespace: "default", name: "web" }], 2 * hour);
    const stats = windowStatsFor(store, "default", "web", "web");
    expect(stats.hoursCovered).toBe(3);
  });

  test("no matching pods → empty stats (hoursCovered 0)", () => {
    const store: SampleStore = new Map();
    ingestSamples(store, metrics, [{ namespace: "default", name: "redis" }], 0);
    const stats = windowStatsFor(store, "default", "redis", "redis");
    expect(stats.hoursCovered).toBe(0);
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
    const store: SampleStore = new Map();
    // No samples yet → insufficient data
    const rows = buildRightSizing(byKind, store);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("deployment");
    expect(rows[0].name).toBe("web");
    expect(rows[0].worst).toBe("insufficientData");
  });

  test("skips workloads with no containers", () => {
    const byKind = {
      deployments: { empty: { metadata: { name: "empty", namespace: "default" } } },
    };
    expect(buildRightSizing(byKind, new Map())).toHaveLength(0);
  });
});
