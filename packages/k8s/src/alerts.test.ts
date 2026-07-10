import { describe, it, expect } from "vitest";
import { normalizeAlertRule, parseAlertRules, serializeAlertRules, nextAlertRules, alertRuleSummary, type SuggestedAlert } from "./alerts";

const block = {
  label: "Alert: postgres down",
  text: "text me if the postgres database in prod goes down",
  target: { scope: "database" as const, namespace: "prod", name: "postgres" },
  condition: { type: "notReady" as const, minutes: 2 },
};

describe("normalizeAlertRule", () => {
  it("assigns id/enabled/createdAt and defaults cooldown from the condition window", () => {
    const r = normalizeAlertRule(block, "id-1", 1_700_000_000_000);
    expect(r.id).toBe("id-1");
    expect(r.enabled).toBe(true);
    expect(r.createdAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(r.cooldownMinutes).toBe(5); // minutes:2 is below the 5-min floor → 5
  });
  it("defaults cooldown to windowMinutes for podRestarts", () => {
    const r = normalizeAlertRule(
      { ...block, condition: { type: "podRestarts", threshold: 3, windowMinutes: 60 } },
      "id-2", 0,
    );
    expect(r.cooldownMinutes).toBe(60);
  });
  it("throws on an unknown condition type", () => {
    expect(() => normalizeAlertRule({ ...block, condition: { type: "nope" } as any }, "x", 0)).toThrow();
  });
  it("throws when a workload/pod target omits namespace", () => {
    const noNs = { scope: "workload" as const, kind: "Deployment" as const, name: "web" };
    expect(() => normalizeAlertRule({ ...block, target: noNs }, "x", 0)).toThrow();
    const podNoNs = { scope: "pod" as const, name: "web-1" };
    expect(() => normalizeAlertRule({ ...block, target: podNoNs }, "x", 0)).toThrow();
  });
  it("throws when a database target omits namespace", () => {
    const noNs = { scope: "database" as const, name: "postgres" };
    expect(() => normalizeAlertRule({ ...block, target: noNs }, "x", 0)).toThrow();
  });
  it("throws on deploymentDegraded with a pod/database target", () => {
    expect(() => normalizeAlertRule({ ...block, target: { scope: "pod" as const, namespace: "prod", name: "p" }, condition: { type: "deploymentDegraded" as const, minutes: 5 } }, "x", 0)).toThrow();
  });
});

describe("parse/serialize round-trip", () => {
  it("drops malformed entries, keeps valid ones", () => {
    const r = normalizeAlertRule(block, "id-1", 0);
    const json = serializeAlertRules([r]);
    expect(parseAlertRules(json)).toEqual([r]);
    expect(parseAlertRules('[{"id":"x"}]')).toEqual([]); // missing required fields
    expect(parseAlertRules("not json")).toEqual([]);
    expect(parseAlertRules(undefined)).toEqual([]);
  });
});

describe("nextAlertRules", () => {
  const r = normalizeAlertRule(block, "id-1", 0);
  it("adds, toggles, and deletes by id", () => {
    expect(nextAlertRules([], { op: "add", rule: r })).toEqual([r]);
    expect(nextAlertRules([r], { op: "toggle", id: "id-1", enabled: false })[0]!.enabled).toBe(false);
    expect(nextAlertRules([r], { op: "delete", id: "id-1" })).toEqual([]);
  });
});

describe("alertRuleSummary", () => {
  it("renders a human one-liner with the target", () => {
    expect(alertRuleSummary(normalizeAlertRule(block, "id-1", 0))).toContain("database prod/postgres");
  });
});

describe("metricThreshold condition", () => {
  const metricBlock = (over: Partial<SuggestedAlert> = {}): SuggestedAlert => ({
    label: "Alert: node memory high",
    text: "alert when a node's memory goes above 90%",
    target: { scope: "node" },
    condition: { type: "metricThreshold", metric: "memoryPercent", comparator: "above", threshold: 90, minutes: 10 },
    ...over,
  });

  it("normalizes a node metric rule and defaults cooldown from the for-duration", () => {
    const r = normalizeAlertRule(metricBlock(), "id-m", 1_700_000_000_000);
    expect(r.condition.type).toBe("metricThreshold");
    expect(r.target.scope).toBe("node");
    expect(r.cooldownMinutes).toBe(10);
  });

  it("accepts an optional specific node name", () => {
    const r = normalizeAlertRule(metricBlock({ target: { scope: "node", name: "node-a" } }), "id-m2", 0);
    expect(r.target.name).toBe("node-a");
  });

  it("rejects a metric rule whose target is not node scope", () => {
    expect(() =>
      normalizeAlertRule(metricBlock({ target: { scope: "namespace", namespace: "prod" } }), "x", 0),
    ).toThrow(/require a node target/);
  });

  it("rejects a node-scoped rule with a non-metric condition", () => {
    expect(() =>
      normalizeAlertRule(
        { label: "l", text: "t", target: { scope: "node" }, condition: { type: "crashLoop" } },
        "x",
        0,
      ),
    ).toThrow(/node-scoped/);
  });

  it("rejects an out-of-range threshold", () => {
    expect(() =>
      normalizeAlertRule(metricBlock({ condition: { type: "metricThreshold", metric: "cpuPercent", comparator: "above", threshold: 150, minutes: 5 } }), "x", 0),
    ).toThrow(/threshold/);
  });

  it("summarizes node metric rules", () => {
    const r = normalizeAlertRule(metricBlock(), "id-m", 0);
    expect(alertRuleSummary(r)).toBe("any node — memory above 90% for 10m");
    const r2 = normalizeAlertRule(metricBlock({ target: { scope: "node", name: "node-a" }, condition: { type: "metricThreshold", metric: "cpuPercent", comparator: "above", threshold: 80, minutes: 5 } }), "id-c", 0);
    expect(alertRuleSummary(r2)).toBe("node node-a — CPU above 80% for 5m");
  });
});

describe("node notReady condition", () => {
  const nodeBlock = (over: Partial<SuggestedAlert> = {}): SuggestedAlert => ({
    label: "Alert: node down",
    text: "notify me if the k3s-slave node goes NotReady",
    target: { scope: "node", name: "k3s-slave" },
    condition: { type: "notReady", minutes: 2 },
    ...over,
  });

  it("accepts a node-scoped notReady rule for a named node", () => {
    const r = normalizeAlertRule(nodeBlock(), "id-n", 0);
    expect(r.target.scope).toBe("node");
    expect(r.target.name).toBe("k3s-slave");
    expect(r.condition.type).toBe("notReady");
  });

  it("accepts an all-nodes notReady rule (no name)", () => {
    const r = normalizeAlertRule(nodeBlock({ target: { scope: "node" } }), "id-n2", 0);
    expect(r.target.name).toBeUndefined();
  });

  it("still rejects other node-scoped conditions", () => {
    expect(() => normalizeAlertRule(nodeBlock({ condition: { type: "crashLoop" } }), "x", 0)).toThrow(/node-scoped/);
  });

  it("summarizes a node notReady rule", () => {
    expect(alertRuleSummary(normalizeAlertRule(nodeBlock(), "id-n", 0))).toBe("node k3s-slave — not ready 2m");
  });
});
