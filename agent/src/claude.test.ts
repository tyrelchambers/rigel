import { describe, expect, test } from "vitest";
import { parseClaudeResult } from "./claude.js";

describe("parseClaudeResult", () => {
  test("extracts result text, cost, and success flag from a json envelope", () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "pong",
      total_cost_usd: 0.17424125,
    });
    const r = parseClaudeResult(stdout);
    expect(r.text).toBe("pong");
    expect(r.costUsd).toBeCloseTo(0.17424125, 6);
    expect(r.isError).toBe(false);
  });

  test("surfaces is_error from the envelope", () => {
    const stdout = JSON.stringify({ type: "result", is_error: true, result: "boom", total_cost_usd: 0.01 });
    expect(parseClaudeResult(stdout).isError).toBe(true);
  });

  test("treats missing total_cost_usd as zero", () => {
    const stdout = JSON.stringify({ type: "result", is_error: false, result: "ok" });
    expect(parseClaudeResult(stdout).costUsd).toBe(0);
  });

  test("tolerates leading log noise before the json object", () => {
    const stdout = "some stderr-ish noise\n" + JSON.stringify({ is_error: false, result: "hi", total_cost_usd: 0 });
    expect(parseClaudeResult(stdout).text).toBe("hi");
  });

  test("throws on unparseable output", () => {
    expect(() => parseClaudeResult("not json at all")).toThrow();
  });

  test("surfaces structured_output when --json-schema was used", () => {
    const stdout = JSON.stringify({
      is_error: false,
      result: "{...}",
      total_cost_usd: 0.02,
      structured_output: { decision: "approve", confidence: 0.9, reason: "ok" },
    });
    expect(parseClaudeResult(stdout).structuredOutput).toEqual({
      decision: "approve",
      confidence: 0.9,
      reason: "ok",
    });
  });

  test("structuredOutput is undefined when absent", () => {
    const stdout = JSON.stringify({ is_error: false, result: "hi", total_cost_usd: 0 });
    expect(parseClaudeResult(stdout).structuredOutput).toBeUndefined();
  });
});
