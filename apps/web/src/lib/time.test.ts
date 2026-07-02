import { describe, expect, test } from "vitest";
import { compactAge, spelledAge } from "./time";

const now = Date.parse("2026-06-09T12:00:00Z");
const at = (iso: string) => Date.parse(iso);

describe("compactAge", () => {
  test("largest unit, compact", () => {
    expect(compactAge("2026-06-09T11:59:55Z", { now })).toBe("5s");
    expect(compactAge("2026-06-09T11:57:00Z", { now })).toBe("3m");
    expect(compactAge("2026-06-09T10:00:00Z", { now })).toBe("2h");
    expect(compactAge("2026-06-07T12:00:00Z", { now })).toBe("2d");
  });

  test("accepts epoch-ms input", () => {
    expect(compactAge(at("2026-06-09T11:59:55Z"), { now })).toBe("5s");
  });

  test("invalid: default dash, override, and null", () => {
    expect(compactAge(undefined, { now })).toBe("—");
    expect(compactAge("not-a-date", { now })).toBe("—");
    expect(compactAge(null, { now })).toBe("—");
    expect(compactAge(undefined, { now, invalid: "" })).toBe("");
    expect(compactAge(undefined, { now, invalid: null })).toBe(null);
  });

  test("clampFuture renders negative delta as 0s", () => {
    expect(compactAge("2026-06-09T12:00:30Z", { now, clampFuture: true })).toBe("0s");
  });

  test("suffix appends ' ago'", () => {
    expect(compactAge("2026-06-09T11:59:18Z", { now, suffix: true })).toBe("42s ago");
    expect(compactAge("2026-06-09T11:57:00Z", { now, suffix: true })).toBe("3m ago");
    expect(compactAge("2026-06-09T08:00:00Z", { now, suffix: true })).toBe("4h ago");
    expect(compactAge("2026-06-06T12:00:00Z", { now, suffix: true })).toBe("3d ago");
  });

  test("maxUnit 'h' never rolls up to days", () => {
    // 25h ago would be "1d" with the default cap, but "25h" when capped at hours.
    expect(compactAge("2026-06-08T11:00:00Z", { now, maxUnit: "h" })).toBe("25h");
  });

  test("belowMinute 'just now' phrase", () => {
    expect(compactAge("2026-06-09T11:59:30Z", { now, belowMinute: "just now" })).toBe("just now");
    // still uses real buckets above a minute
    expect(compactAge("2026-06-09T11:57:00Z", { now, belowMinute: "just now" })).toBe("3m");
  });

  test("belowMinute + suffix together (ageDescription shape)", () => {
    expect(compactAge(at("2026-06-09T11:55:00Z"), { now, suffix: true, belowMinute: "just now" })).toBe("5m ago");
    expect(compactAge(at("2026-06-09T11:59:40Z"), { now, suffix: true, belowMinute: "just now" })).toBe("just now");
  });
});

describe("spelledAge", () => {
  test("just now below a minute and for future", () => {
    expect(spelledAge("2026-06-09T11:59:30Z", now)).toBe("just now");
    expect(spelledAge("2026-06-09T12:05:00Z", now)).toBe("just now");
  });
  test("largest unit, pluralized", () => {
    expect(spelledAge("2026-06-09T11:59:00Z", now)).toBe("1 minute");
    expect(spelledAge("2026-06-09T11:55:00Z", now)).toBe("5 minutes");
    expect(spelledAge("2026-06-09T11:00:00Z", now)).toBe("1 hour");
    expect(spelledAge("2025-12-26T12:00:00Z", now)).toBe("165 days");
  });
  test("empty string for invalid input", () => {
    expect(spelledAge(undefined, now)).toBe("");
    expect(spelledAge("not-a-date", now)).toBe("");
  });
});
