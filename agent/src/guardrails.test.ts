import { describe, expect, test } from "vitest";
import { CircuitBreaker } from "./guardrails.js";

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

describe("CircuitBreaker.updateLimits (live limit changes)", () => {
  const cfg = { maxPerResourcePerHour: 2, maxPerNight: 5, maxAttemptsPerIncident: 3, windowMs: 24 * HOUR };

  test("a raised per-resource cap takes effect WITHOUT losing history", () => {
    const cb = new CircuitBreaker(cfg);
    cb.record("fp1", "default/memos", 0);
    cb.record("fp2", "default/memos", 10);
    expect(cb.canAct("fp3", "default/memos", 20).allowed).toBe(false); // capped at 2
    cb.updateLimits({ maxPerResourcePerHour: 5 });
    // History (the two prior records) is preserved, but the cap is now 5 → allowed.
    expect(cb.canAct("fp3", "default/memos", 20).allowed).toBe(true);
  });

  test("a lowered nightly cap takes effect immediately", () => {
    const cb = new CircuitBreaker({ ...cfg, maxPerResourcePerHour: 99, maxAttemptsPerIncident: 99 });
    for (let i = 0; i < 3; i++) cb.record(`fp${i}`, `default/r${i}`, i);
    expect(cb.canAct("fpX", "default/rX", 6).allowed).toBe(true); // under nightly 5
    cb.updateLimits({ maxPerNight: 3 });
    expect(cb.canAct("fpX", "default/rX", 6).allowed).toBe(false); // now at the lowered cap
  });

  test("updateLimits ignores undefined fields (a partial update keeps the rest)", () => {
    const cb = new CircuitBreaker(cfg);
    cb.updateLimits({ maxPerNight: 99 });
    cb.record("loop", "default/api", 0);
    cb.record("loop", "default/api", 1);
    cb.record("loop", "default/api", 2);
    // maxAttemptsPerIncident is untouched (still 3) → blocked.
    expect(cb.canAct("loop", "default/api", 3).allowed).toBe(false);
  });
});
