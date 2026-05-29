import { describe, expect, test } from "vitest";
import { classifyRisk, RiskTier } from "./classifier.js";

describe("classifyRisk", () => {
  test("restart is LOW (auto-remediate)", () => {
    expect(classifyRisk("restart")).toBe(RiskTier.Low);
  });

  test("rollback is LOW (auto-remediate)", () => {
    expect(classifyRisk("rollback")).toBe(RiskTier.Low);
  });

  test("deletePod is LOW (crashlooping pod is recreated by its controller)", () => {
    expect(classifyRisk("deletePod")).toBe(RiskTier.Low);
  });

  test("cordon is LOW", () => {
    expect(classifyRisk("cordon")).toBe(RiskTier.Low);
  });

  test("scale is MEDIUM (Opus-gated)", () => {
    expect(classifyRisk("scale")).toBe(RiskTier.Medium);
  });

  test("setEnv is MEDIUM (Opus-gated)", () => {
    expect(classifyRisk("setEnv")).toBe(RiskTier.Medium);
  });

  test("uncordon is MEDIUM (Opus-gated)", () => {
    expect(classifyRisk("uncordon")).toBe(RiskTier.Medium);
  });

  test("an unknown kind is BLOCKED (fail safe — never executable)", () => {
    expect(classifyRisk("deleteNamespace")).toBe(RiskTier.Blocked);
    expect(classifyRisk("drain")).toBe(RiskTier.Blocked);
    expect(classifyRisk("totallyMadeUp")).toBe(RiskTier.Blocked);
  });
});
