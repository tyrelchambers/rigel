import { describe, expect, test } from "vitest";
import { appendAudit, capBackups, emptyState, type AuditEntry } from "./state.js";

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
