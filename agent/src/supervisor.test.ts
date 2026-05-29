import { describe, expect, test } from "vitest";
import { parseVerdict } from "./supervisor.js";

describe("parseVerdict", () => {
  test("accepts a well-formed approve verdict", () => {
    expect(parseVerdict({ decision: "approve", confidence: 0.92, reason: "rollback matches the bad rollout" })).toEqual({
      decision: "approve",
      confidence: 0.92,
      reason: "rollback matches the bad rollout",
    });
  });

  test("accepts reject and escalate decisions", () => {
    expect(parseVerdict({ decision: "reject", confidence: 0.4, reason: "no evidence" }).decision).toBe("reject");
    expect(parseVerdict({ decision: "escalate", confidence: 0.5, reason: "needs a human" }).decision).toBe("escalate");
  });

  test("clamps confidence into [0,1]", () => {
    expect(parseVerdict({ decision: "approve", confidence: 1.7, reason: "x" }).confidence).toBe(1);
    expect(parseVerdict({ decision: "approve", confidence: -3, reason: "x" }).confidence).toBe(0);
  });

  test("defaults a missing/non-numeric confidence to 0 (treated as low)", () => {
    expect(parseVerdict({ decision: "approve", reason: "x" }).confidence).toBe(0);
  });

  test("throws on an unknown decision (fail-closed)", () => {
    expect(() => parseVerdict({ decision: "yolo", confidence: 1, reason: "x" })).toThrow();
  });

  test("throws on a non-object", () => {
    expect(() => parseVerdict(null)).toThrow();
    expect(() => parseVerdict("approve")).toThrow();
  });
});
