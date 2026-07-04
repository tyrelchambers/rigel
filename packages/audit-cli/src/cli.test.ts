import { describe, it, expect } from "vitest";
import { parseArgs, runAudit } from "./index";
import { groupByKind } from "./gather";
import type { KubectlRunner } from "./kubectl";

// --- helpers ---------------------------------------------------------------

const MiB = 1024 * 1024;

/** A kubectl List payload from a set of raw objects (each tagged with its kind). */
function list(items: unknown[]): string {
  return JSON.stringify({ apiVersion: "v1", kind: "List", items });
}

/** A Deployment raw object with a single container; knobs for the fields the
 *  audits read. */
function deployment(opts: {
  name: string;
  namespace?: string;
  replicas?: number;
  privileged?: boolean;
  memLimit?: string;
  cpuLimit?: string;
}): unknown {
  const sc = opts.privileged ? { privileged: true } : undefined;
  const limits: Record<string, string> = {};
  if (opts.cpuLimit) limits.cpu = opts.cpuLimit;
  if (opts.memLimit) limits.memory = opts.memLimit;
  return {
    kind: "Deployment",
    metadata: { name: opts.name, namespace: opts.namespace ?? "default" },
    spec: {
      replicas: opts.replicas ?? 1,
      template: {
        metadata: { labels: { app: opts.name } },
        spec: {
          containers: [
            {
              name: opts.name,
              image: "nginx:1.27.0",
              securityContext: sc,
              resources: Object.keys(limits).length ? { limits } : undefined,
            },
          ],
        },
      },
    },
  };
}

const METRICS_SERVICE = {
  metadata: { name: "rigel-metrics", namespace: "rigel-metrics" },
  spec: { ports: [{ port: 8428 }] },
};

function promSeries(series: Array<{ ns: string; pod: string; container: string; value: number }>): string {
  return JSON.stringify({
    status: "success",
    data: {
      result: series.map((s) => ({
        metric: { namespace: s.ns, pod: s.pod, container: s.container },
        value: [0, String(s.value)],
      })),
    },
  });
}

// --- parseArgs -------------------------------------------------------------

describe("parseArgs", () => {
  it("parses the kind plus flags", () => {
    expect(parseArgs(["security", "--context", "prod", "--namespace", "web", "--json"])).toEqual({
      kind: "security",
      context: "prod",
      namespace: "web",
      json: true,
    });
  });

  it("defaults context to null and json to false", () => {
    expect(parseArgs(["reliability"])).toEqual({ kind: "reliability", context: null, namespace: undefined, json: false });
  });

  it("throws on an unknown kind", () => {
    expect(() => parseArgs(["bogus"])).toThrow(/Unknown audit kind/);
  });

  it("throws on a missing kind and on an unknown flag", () => {
    expect(() => parseArgs([])).toThrow(/Missing audit kind/);
    expect(() => parseArgs(["security", "--nope"])).toThrow(/Unknown flag/);
  });
});

// --- groupByKind -----------------------------------------------------------

describe("groupByKind", () => {
  it("keys items by watch-kind then namespace/name, skipping unknown kinds", () => {
    const grouped = groupByKind([
      { kind: "Deployment", metadata: { name: "web", namespace: "default" } },
      { kind: "HorizontalPodAutoscaler", metadata: { name: "web", namespace: "default" } },
      { kind: "Pod", metadata: { name: "ignore", namespace: "default" } },
    ]);
    expect(Object.keys(grouped).sort()).toEqual(["deployments", "horizontalpodautoscalers"]);
    expect(grouped.deployments["default/web"]).toBeDefined();
  });
});

// --- runAudit --------------------------------------------------------------

/** Dispatch a stub runner by the kubectl args: workloads, services, or a
 *  usage --raw instant query (routed by the promql metric in the encoded path). */
function stubRunner(opts: {
  workloads: string;
  services?: string;
  usage?: { cpuPeak?: number; memPeak?: number; count?: number; pod?: string };
}): KubectlRunner {
  return async (args: string[]) => {
    if (args[1] === "services") return opts.services ?? list([]);
    if (args.includes("--raw")) {
      // The query is percent-encoded (promEncode encodes underscores too), so
      // match on the bare alphanumeric tokens that survive: count, cpu, quantile.
      const path = args[args.indexOf("--raw") + 1];
      const u = opts.usage ?? {};
      const pod = u.pod ?? "web-abc";
      if (path.includes("count")) return promSeries([{ ns: "default", pod, container: "web", value: u.count ?? 0 }]);
      if (path.includes("cpu")) {
        return path.includes("quantile")
          ? promSeries([])
          : promSeries([{ ns: "default", pod, container: "web", value: u.cpuPeak ?? 0 }]);
      }
      // memory
      return path.includes("quantile")
        ? promSeries([])
        : promSeries([{ ns: "default", pod, container: "web", value: u.memPeak ?? 0 }]);
    }
    return opts.workloads; // the `get deployments,... -o json` call
  };
}

/** The runAudit output findings are a union across the three engines, typed as
 *  unknown[] on the shared result; narrow to the fields the assertions read. */
type AnyFinding = { type: string; severity?: string; evidence?: { cpuPeak?: number; memLimit?: number } };
const findingsOf = (out: { findings: unknown[] }): AnyFinding[] => out.findings as AnyFinding[];

describe("runAudit", () => {
  it("reliability flags a single-replica deployment", async () => {
    const runner = stubRunner({ workloads: list([deployment({ name: "web", replicas: 1 })]) });
    const out = await runAudit("reliability", runner);
    expect(out.audit).toBe("reliability");
    expect(findingsOf(out).some((f) => f.type === "singleReplica")).toBe(true);
    expect(out.counts.total).toBe(out.findings.length);
  });

  it("security flags a privileged container", async () => {
    const runner = stubRunner({ workloads: list([deployment({ name: "web", privileged: true })]) });
    const out = await runAudit("security", runner);
    const f = findingsOf(out).find((x) => x.type === "privilegedContainer");
    expect(f?.severity).toBe("critical");
  });

  it("performance with NO metrics backend runs spec-only (no evidence)", async () => {
    const runner = stubRunner({
      // multi-replica, no memory limit, no HPA -> spec findings noMemoryLimit + noAutoscaling
      workloads: list([deployment({ name: "api", replicas: 2 })]),
      services: list([]), // no metrics backend
    });
    const out = await runAudit("performance", runner);
    const findings = findingsOf(out);
    expect(out.metricsBackend).toEqual({ used: false });
    expect(findings.some((f) => f.type === "noMemoryLimit")).toBe(true);
    expect(findings.some((f) => f.type === "cpuThrottlingRisk" || f.type === "memoryPressure")).toBe(false);
    expect(findings.every((f) => f.evidence === undefined)).toBe(true);
  });

  it("performance WITH a metrics backend attaches evidence and metrics findings", async () => {
    const runner = stubRunner({
      // single replica + a mem limit so the ONLY findings are metrics-based
      workloads: list([deployment({ name: "web", replicas: 1, cpuLimit: "1", memLimit: "100Mi" })]),
      services: list([METRICS_SERVICE]),
      usage: { cpuPeak: 0.98, memPeak: 100 * 1000 * 1000, count: 2000, pod: "web-abc" }, // ~33h history
    });
    const out = await runAudit("performance", runner);
    const findings = findingsOf(out);
    expect(out.metricsBackend).toMatchObject({ used: true, flavor: "VictoriaMetrics" });
    const throttle = findings.find((f) => f.type === "cpuThrottlingRisk");
    const pressure = findings.find((f) => f.type === "memoryPressure");
    expect(throttle).toBeDefined();
    expect(pressure).toBeDefined();
    expect(throttle?.evidence?.cpuPeak).toBeCloseTo(0.98);
    expect(pressure?.evidence?.memLimit).toBe(100 * MiB);
  });
});
