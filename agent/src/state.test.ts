import { describe, expect, test } from "vitest";
import { appendAudit, capBackups, emptyState, reconcileQueue, type AuditEntry, type QueuedSuggestion } from "./state.js";

function entry(at: string, fingerprint: string): AuditEntry {
  return {
    at,
    fingerprint,
    incident: "x",
    tier: "low",
    outcome: "success",
    detail: "",
  };
}

describe("appendAudit", () => {
  test("prepends the newest entry (newest first)", () => {
    const s1 = appendAudit(emptyState(), entry("2026-05-29T01:00:00Z", "a"), 50);
    const s2 = appendAudit(s1, entry("2026-05-29T02:00:00Z", "b"), 50);
    expect(s2.audit.map((e) => e.fingerprint)).toEqual(["b", "a"]);
  });

  test("caps the log at maxEntries, dropping the oldest", () => {
    let s = emptyState();
    for (let i = 0; i < 10; i++) s = appendAudit(s, entry(`t${i}`, `fp${i}`), 3);
    expect(s.audit).toHaveLength(3);
    expect(s.audit.map((e) => e.fingerprint)).toEqual(["fp9", "fp8", "fp7"]);
  });

  test("stamps updatedAt from the appended entry", () => {
    const s = appendAudit(emptyState(), entry("2026-05-29T03:00:00Z", "a"), 50);
    expect(s.updatedAt).toBe("2026-05-29T03:00:00Z");
  });

  test("does not mutate the input state", () => {
    const before = emptyState();
    appendAudit(before, entry("t", "a"), 50);
    expect(before.audit).toEqual([]);
  });
});

describe("capBackups", () => {
  test("keeps the newest N keys (timestamp-prefixed sort) and drops the oldest", () => {
    const data = { "2026-01-01_a": "1", "2026-01-02_b": "2", "2026-01-03_c": "3" };
    expect(capBackups(data, 2)).toEqual({ "2026-01-02_b": "2", "2026-01-03_c": "3" });
  });

  test("returns the data unchanged when under the cap", () => {
    const data = { "2026-01-01_a": "1" };
    expect(capBackups(data, 5)).toEqual(data);
  });

  test("a cap of zero drops everything", () => {
    expect(capBackups({ "2026-01-01_a": "1" }, 0)).toEqual({});
  });
});

describe("reconcileQueue", () => {
  const HOUR = 3_600_000;
  const NOW = Date.parse("2026-06-19T12:00:00Z");
  const TTL = 48 * HOUR;

  function q(over: Partial<QueuedSuggestion>): QueuedSuggestion {
    return { at: "2026-06-19T11:00:00Z", incident: "i", suggestion: "s", reason: "r", ...over };
  }

  const bothKinds = new Set(["unhealthyPod", "degradedDeployment"]);

  test("keeps an item whose incident is still present", () => {
    const item = q({ fingerprint: "unhealthyPod|default|web|CrashLoopBackOff" });
    const r = reconcileQueue([item], new Set([item.fingerprint!]), bothKinds, NOW, TTL);
    expect(r.kept).toEqual([item]);
    expect(r.cleared).toEqual([]);
  });

  test("clears an item whose incident cleared and whose kind was checked", () => {
    const item = q({ fingerprint: "unhealthyPod|default|web|CrashLoopBackOff" });
    const r = reconcileQueue([item], new Set(), bothKinds, NOW, TTL);
    expect(r.kept).toEqual([]);
    expect(r.cleared).toHaveLength(1);
    expect(r.cleared[0]!.reason).toMatch(/no longer present/);
  });

  test("does NOT clear when detection for that kind did not run this tick", () => {
    const item = q({ fingerprint: "degradedDeployment|default|api|Degraded" });
    // Only pods were checked; the deployment detection didn't run → can't confirm.
    const r = reconcileQueue([item], new Set(), new Set(["unhealthyPod"]), NOW, TTL);
    expect(r.kept).toEqual([item]);
    expect(r.cleared).toEqual([]);
  });

  test("TTL backstop clears an unverifiable item older than the TTL", () => {
    const old = q({ fingerprint: "degradedDeployment|default|api|Degraded", at: "2026-06-16T11:00:00Z" });
    const r = reconcileQueue([old], new Set(), new Set(["unhealthyPod"]), NOW, TTL);
    expect(r.kept).toEqual([]);
    expect(r.cleared[0]!.reason).toMatch(/stale/);
  });

  test("keeps a legacy item without a fingerprint until the TTL", () => {
    const recent = q({ at: "2026-06-19T11:00:00Z" }); // no fingerprint, recent
    const old = q({ at: "2026-06-16T11:00:00Z" }); // no fingerprint, stale
    const r = reconcileQueue([recent, old], new Set(), bothKinds, NOW, TTL);
    expect(r.kept).toEqual([recent]);
    expect(r.cleared).toHaveLength(1);
    expect(r.cleared[0]!.item).toBe(old);
  });
});
