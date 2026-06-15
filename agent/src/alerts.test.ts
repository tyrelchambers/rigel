import { describe, it, expect } from "vitest";
import { parseAlertRules, evaluateAlertRules, emptyAlertState, type AlertRule } from "./alerts.js";

const T0 = Date.parse("2026-06-15T00:00:00Z");
const min = (n: number) => n * 60_000;

function pod(ns: string, name: string, opts: {
  restarts?: number; waiting?: string; oom?: boolean; phase?: string; startedMinAgo?: number; readyFalseMinAgo?: number; labels?: Record<string, string>;
} = {}) {
  const startTime = opts.startedMinAgo != null ? new Date(T0 - min(opts.startedMinAgo)).toISOString() : undefined;
  return {
    metadata: { name, namespace: ns, labels: opts.labels },
    status: {
      phase: opts.phase ?? "Running",
      startTime,
      conditions: opts.readyFalseMinAgo != null
        ? [{ type: "Ready", status: "False", lastTransitionTime: new Date(T0 - min(opts.readyFalseMinAgo)).toISOString() }]
        : [{ type: "Ready", status: "True", lastTransitionTime: startTime }],
      containerStatuses: [{
        restartCount: opts.restarts ?? 0,
        state: opts.waiting ? { waiting: { reason: opts.waiting } } : {},
        lastState: opts.oom ? { terminated: { reason: "OOMKilled" } } : {},
      }],
    },
  };
}

function deployment(ns: string, name: string, desired: number, ready: number, degradedMinAgo = 30) {
  return {
    metadata: { name, namespace: ns },
    spec: { replicas: desired },
    status: {
      replicas: desired, readyReplicas: ready,
      conditions: [{ type: "Available", status: ready < desired ? "False" : "True", lastTransitionTime: new Date(T0 - min(degradedMinAgo)).toISOString() }],
    },
  };
}

const rule = (over: Partial<AlertRule>): AlertRule => ({
  id: "r1", enabled: true, text: "t", cooldownMinutes: 5,
  target: { scope: "namespace", namespace: "prod" },
  condition: { type: "crashLoop" }, createdAt: "", ...over,
});

describe("crashLoop", () => {
  it("fires for a matching crash-looping pod and respects cooldown", () => {
    const pods = [pod("prod", "web-abc", { waiting: "CrashLoopBackOff" })];
    const r = evaluateAlertRules([rule({})], pods, [], emptyAlertState(), T0);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.ruleId).toBe("r1");
    const r2 = evaluateAlertRules([rule({})], pods, [], r.alertState, T0 + min(2));
    expect(r2.events).toHaveLength(0);
    const r3 = evaluateAlertRules([rule({})], pods, [], r.alertState, T0 + min(6));
    expect(r3.events).toHaveLength(1);
  });
  it("does not fire for healthy pods or non-matching namespace", () => {
    expect(evaluateAlertRules([rule({})], [pod("prod", "web", {})], [], emptyAlertState(), T0).events).toHaveLength(0);
    expect(evaluateAlertRules([rule({})], [pod("dev", "web", { waiting: "CrashLoopBackOff" })], [], emptyAlertState(), T0).events).toHaveLength(0);
  });
});

describe("podRestarts tumbling window", () => {
  const rr = rule({ condition: { type: "podRestarts", threshold: 3, windowMinutes: 60 }, cooldownMinutes: 60 });
  it("fires once restarts climb >= threshold within the window", () => {
    const s0 = evaluateAlertRules([rr], [pod("prod", "web", { restarts: 10 })], [], emptyAlertState(), T0);
    expect(s0.events).toHaveLength(0);
    const s1 = evaluateAlertRules([rr], [pod("prod", "web", { restarts: 13 })], [], s0.alertState, T0 + min(10));
    expect(s1.events).toHaveLength(1);
  });
  it("resets the baseline after the window elapses", () => {
    const s0 = evaluateAlertRules([rr], [pod("prod", "web", { restarts: 10 })], [], emptyAlertState(), T0);
    const s1 = evaluateAlertRules([rr], [pod("prod", "web", { restarts: 12 })], [], s0.alertState, T0 + min(61));
    expect(s1.events).toHaveLength(0);
  });
});

describe("duration conditions", () => {
  it("oomKilled fires on a terminated OOM", () => {
    expect(evaluateAlertRules([rule({ condition: { type: "oomKilled" } })], [pod("prod", "db", { oom: true })], [], emptyAlertState(), T0).events).toHaveLength(1);
  });
  it("pendingTooLong only fires past the threshold", () => {
    const r = rule({ condition: { type: "pendingTooLong", minutes: 10 } });
    expect(evaluateAlertRules([r], [pod("prod", "p", { phase: "Pending", startedMinAgo: 5 })], [], emptyAlertState(), T0).events).toHaveLength(0);
    expect(evaluateAlertRules([r], [pod("prod", "p", { phase: "Pending", startedMinAgo: 15 })], [], emptyAlertState(), T0).events).toHaveLength(1);
  });
  it("notReady fires when Ready=False longer than the threshold", () => {
    const r = rule({ condition: { type: "notReady", minutes: 5 } });
    expect(evaluateAlertRules([r], [pod("prod", "p", { readyFalseMinAgo: 9 })], [], emptyAlertState(), T0).events).toHaveLength(1);
  });
  it("deploymentDegraded fires for a degraded deployment past the threshold", () => {
    const r = rule({ target: { scope: "workload", kind: "Deployment", namespace: "prod", name: "api" }, condition: { type: "deploymentDegraded", minutes: 10 } });
    expect(evaluateAlertRules([r], [], [deployment("prod", "api", 3, 1, 20)], emptyAlertState(), T0).events).toHaveLength(1);
    expect(evaluateAlertRules([r], [], [deployment("prod", "api", 3, 3, 20)], emptyAlertState(), T0).events).toHaveLength(0);
  });
});

describe("target matching", () => {
  it("database scope matches CNPG pods by cnpg.io/cluster label", () => {
    const r = rule({ target: { scope: "database", namespace: "prod", name: "postgres" }, condition: { type: "crashLoop" } });
    const ok = pod("prod", "postgres-1", { waiting: "CrashLoopBackOff", labels: { "cnpg.io/cluster": "postgres" } });
    const other = pod("prod", "redis-1", { waiting: "CrashLoopBackOff", labels: { "cnpg.io/cluster": "redis" } });
    expect(evaluateAlertRules([r], [ok, other], [], emptyAlertState(), T0).events).toHaveLength(1);
  });
  it("workload scope matches pods by name prefix", () => {
    const r = rule({ target: { scope: "workload", kind: "Deployment", namespace: "prod", name: "web" }, condition: { type: "crashLoop" } });
    expect(evaluateAlertRules([r], [pod("prod", "web-5d-xyz", { waiting: "CrashLoopBackOff" })], [], emptyAlertState(), T0).events).toHaveLength(1);
  });
  it("disabled rules never fire", () => {
    expect(evaluateAlertRules([rule({ enabled: false })], [pod("prod", "x", { waiting: "CrashLoopBackOff" })], [], emptyAlertState(), T0).events).toHaveLength(0);
  });
});

describe("parseAlertRules", () => {
  it("drops malformed and keeps valid", () => {
    expect(parseAlertRules("not json")).toEqual([]);
    expect(parseAlertRules(JSON.stringify([rule({})]))).toHaveLength(1);
  });
});
