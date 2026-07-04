import { describe, it, expect, vi, beforeEach } from "vitest";
import { type AlertRule } from "./alerts.js";

// Mock the agent kubectl runner so we can drive backend detection + queries.
const kubectlMock = vi.hoisted(() => vi.fn());
vi.mock("./kubectl.js", () => ({ kubectl: (...args: unknown[]) => kubectlMock(...args) }));

const T0 = Date.parse("2026-06-15T00:00:00Z");
const min = (n: number) => n * 60_000;

const healthRule: AlertRule = {
  id: "h1", enabled: true, text: "t", cooldownMinutes: 5,
  target: { scope: "namespace", namespace: "prod" }, condition: { type: "crashLoop" }, createdAt: "",
};
const memRule: AlertRule = {
  id: "m1", enabled: true, text: "mem", cooldownMinutes: 5,
  target: { scope: "node" },
  condition: { type: "metricThreshold", metric: "memoryPercent", comparator: "above", threshold: 90, minutes: 0 },
  createdAt: "",
};
const cpuRule: AlertRule = {
  id: "c1", enabled: true, text: "cpu", cooldownMinutes: 5,
  target: { scope: "node" },
  condition: { type: "metricThreshold", metric: "cpuPercent", comparator: "above", threshold: 80, minutes: 0 },
  createdAt: "",
};

const servicesJson = JSON.stringify({
  items: [{ metadata: { name: "rigel-metrics", namespace: "mon" }, spec: { ports: [{ port: 8428 }] } }],
});
const promJson = (node: string, v: string) =>
  JSON.stringify({ status: "success", data: { result: [{ metric: { kubernetes_io_hostname: node }, value: [0, v] }] } });

const isServicesCall = (args: string[]) => args[0] === "get" && args[1] === "services";
const servicesOk = () => ({ code: 0, stdout: servicesJson, stderr: "" });
const servicesCallCount = () =>
  kubectlMock.mock.calls.filter((c) => isServicesCall(c[0] as string[])).length;

// Fresh module per test = fresh module-level backend cache.
async function freshCollect() {
  vi.resetModules();
  const mod = await import("./metrics.js");
  return mod.collectMetricSnapshot;
}

beforeEach(() => {
  kubectlMock.mockReset();
});

describe("collectMetricSnapshot", () => {
  it("returns an empty snapshot without touching the cluster when no metric rules exist", async () => {
    const collect = await freshCollect();
    const snap = await collect([healthRule], T0);
    expect(snap).toEqual({ cpuPercentByNode: {}, memoryPercentByNode: {} });
    expect(kubectlMock).not.toHaveBeenCalled();
  });

  it("queries only the metric a rule needs (cpu-only)", async () => {
    kubectlMock.mockImplementation(async (args: string[]) => {
      if (isServicesCall(args)) return servicesOk();
      if (args.includes("--raw")) return { code: 0, stdout: promJson("node-a", "42"), stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected" };
    });
    const collect = await freshCollect();
    const snap = await collect([cpuRule], T0);
    expect(snap.cpuPercentByNode).toEqual({ "node-a": 42 });
    expect(snap.memoryPercentByNode).toEqual({});
    const rawCalls = kubectlMock.mock.calls.filter((c) => (c[0] as string[]).includes("--raw"));
    expect(rawCalls).toHaveLength(1);
  });

  it("caches the backend within the re-detect window and re-detects after it", async () => {
    kubectlMock.mockImplementation(async (args: string[]) => {
      if (isServicesCall(args)) return servicesOk();
      if (args.includes("--raw")) return { code: 0, stdout: promJson("node-a", "95"), stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    });
    const collect = await freshCollect();
    await collect([memRule], T0);
    expect(servicesCallCount()).toBe(1);
    await collect([memRule], T0 + min(1)); // within 5-min window → no re-detect
    expect(servicesCallCount()).toBe(1);
    await collect([memRule], T0 + min(6)); // past window → re-detect
    expect(servicesCallCount()).toBe(2);
  });

  it("keeps the cached backend when re-detection fails, and retries on the next tick", async () => {
    let failServices = false;
    kubectlMock.mockImplementation(async (args: string[]) => {
      if (isServicesCall(args)) return failServices ? { code: 1, stdout: "", stderr: "boom" } : servicesOk();
      if (args.includes("--raw")) return { code: 0, stdout: promJson("node-a", "95"), stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    });
    const collect = await freshCollect();
    await collect([memRule], T0); // detect ok
    failServices = true;
    const snap = await collect([memRule], T0 + min(6)); // re-detect fails → keep cache
    expect(snap.memoryPercentByNode).toEqual({ "node-a": 95 }); // still queried via retained backend
    const afterFail = servicesCallCount();
    await collect([memRule], T0 + min(6) + 1); // failure didn't advance lastDetectMs → retries immediately
    expect(servicesCallCount()).toBe(afterFail + 1);
  });
});
