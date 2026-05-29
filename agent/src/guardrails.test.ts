import { describe, expect, test } from "vitest";
import { CircuitBreaker, SpendTracker } from "./guardrails.js";

const HOUR = 3_600_000;

describe("CircuitBreaker", () => {
  const cfg = { maxPerResourcePerHour: 2, maxPerNight: 5, maxAttemptsPerIncident: 3, windowMs: 24 * HOUR };

  test("allows the first action for a resource", () => {
    const cb = new CircuitBreaker(cfg);
    expect(cb.canAct("fp1", "default/memos", 1000).allowed).toBe(true);
  });

  test("blocks once the per-resource hourly cap is hit", () => {
    const cb = new CircuitBreaker(cfg);
    cb.record("fp1", "default/memos", 0);
    cb.record("fp2", "default/memos", 10);
    const verdict = cb.canAct("fp3", "default/memos", 20);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/resource/i);
  });

  test("lets a resource act again after its actions age out of the hour window", () => {
    const cb = new CircuitBreaker(cfg);
    cb.record("fp1", "default/memos", 0);
    cb.record("fp2", "default/memos", 10);
    expect(cb.canAct("fp3", "default/memos", HOUR + 1).allowed).toBe(true);
  });

  test("blocks repeated attempts on the same incident after K tries (anti-thrash)", () => {
    const cb = new CircuitBreaker({ ...cfg, maxPerResourcePerHour: 99 });
    cb.record("loop", "default/api", 0);
    cb.record("loop", "default/api", 1);
    cb.record("loop", "default/api", 2);
    const verdict = cb.canAct("loop", "default/api", 3);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/attempt|incident|repeat/i);
  });

  test("blocks once the nightly total cap is hit across all resources", () => {
    const cb = new CircuitBreaker({ ...cfg, maxPerResourcePerHour: 99, maxAttemptsPerIncident: 99 });
    for (let i = 0; i < 5; i++) cb.record(`fp${i}`, `default/r${i}`, i);
    expect(cb.canAct("fpX", "default/rX", 6).allowed).toBe(false);
    expect(cb.canAct("fpX", "default/rX", 6).reason).toMatch(/night|total|cap/i);
  });
});

describe("SpendTracker", () => {
  test("allows spending while under the cap", () => {
    const s = new SpendTracker(1.0);
    expect(s.canSpend()).toBe(true);
  });

  test("accumulates cost and blocks once the cap is reached", () => {
    const s = new SpendTracker(1.0);
    s.add(0.6);
    expect(s.canSpend()).toBe(true);
    s.add(0.5);
    expect(s.canSpend()).toBe(false);
  });

  test("reports remaining budget, clamped at zero", () => {
    const s = new SpendTracker(1.0);
    s.add(0.25);
    expect(s.remaining()).toBeCloseTo(0.75, 5);
    s.add(5);
    expect(s.remaining()).toBe(0);
  });

  test("a cap of zero disables model calls entirely", () => {
    const s = new SpendTracker(0);
    expect(s.canSpend()).toBe(false);
  });

  test("restore seeds the running total (survives a pod restart)", () => {
    const s = new SpendTracker(1.0);
    s.restore(0.4, "2026-05");
    expect(s.total()).toBeCloseTo(0.4, 5);
    expect(s.currentMonth()).toBe("2026-05");
  });

  test("syncMonth to the same month keeps accumulated spend", () => {
    const s = new SpendTracker(1.0);
    s.restore(0.4, "2026-05");
    s.syncMonth("2026-05");
    expect(s.total()).toBeCloseTo(0.4, 5);
  });

  test("syncMonth to a new month resets spend (monthly credit cycle)", () => {
    const s = new SpendTracker(1.0);
    s.restore(0.9, "2026-05");
    s.syncMonth("2026-06");
    expect(s.total()).toBe(0);
    expect(s.currentMonth()).toBe("2026-06");
    expect(s.canSpend()).toBe(true);
  });
});
