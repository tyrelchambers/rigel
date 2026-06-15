import { describe, it, expect } from "bun:test";
import { normalizeAlertRule, parseAlertRules, serializeAlertRules, nextAlertRules, alertRuleSummary } from "./alerts";

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
    expect(r.cooldownMinutes).toBe(5); // notReady has no window → min 5
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
