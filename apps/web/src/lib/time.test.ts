import { describe, expect, test } from "vitest";
import { compactAge, compactFromSeconds, spelledAge, spelledSeconds } from "./time";

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

describe("compactFromSeconds", () => {
  test("largest unit via floor", () => {
    expect(compactFromSeconds(45)).toBe("45s");
    expect(compactFromSeconds(0)).toBe("0s");
    expect(compactFromSeconds(5 * 60)).toBe("5m");
    expect(compactFromSeconds(3 * 3600)).toBe("3h");
    expect(compactFromSeconds(344 * 86400)).toBe("344d");
  });
  test("floors fractional and partial units", () => {
    expect(compactFromSeconds(59.9)).toBe("59s");
    expect(compactFromSeconds(90)).toBe("1m");
    expect(compactFromSeconds(90 * 60)).toBe("1h");
  });
});

describe("spelledSeconds", () => {
  test("largest unit, pluralized, floored", () => {
    expect(spelledSeconds(62 * 86400)).toBe("62 days");
    expect(spelledSeconds(1 * 86400)).toBe("1 day");
    expect(spelledSeconds(3 * 3600)).toBe("3 hours");
    expect(spelledSeconds(1 * 3600)).toBe("1 hour");
    expect(spelledSeconds(5 * 60)).toBe("5 minutes");
    expect(spelledSeconds(1 * 60)).toBe("1 minute");
  });
  test("belowMinute default is 'just now'", () => {
    expect(spelledSeconds(45)).toBe("just now");
    expect(spelledSeconds(0)).toBe("just now");
  });
  test("belowMinute 'seconds' spells the sub-minute count", () => {
    expect(spelledSeconds(45, { belowMinute: "seconds" })).toBe("45 seconds");
    expect(spelledSeconds(1, { belowMinute: "seconds" })).toBe("1 second");
    expect(spelledSeconds(0, { belowMinute: "seconds" })).toBe("0 seconds");
  });
  test("negatives clamp to zero", () => {
    expect(spelledSeconds(-5, { belowMinute: "seconds" })).toBe("0 seconds");
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
