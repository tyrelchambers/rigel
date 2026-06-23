import { describe, expect, test } from "vitest";
import { structuredInstruction, extractJsonObjectLoose } from "./structured.js";

describe("structuredInstruction", () => {
  test("embeds the schema and demands JSON-only output", () => {
    const s = structuredInstruction("{\"type\":\"object\"}");
    expect(s).toMatch(/ONLY/i);
    expect(s).toContain("{\"type\":\"object\"}");
    expect(s).toMatch(/no prose|no markdown|no fences/i);
  });
});

describe("extractJsonObjectLoose", () => {
  test("parses a clean JSON object", () => {
    expect(extractJsonObjectLoose(`{"decision":"approve","confidence":0.9,"reason":"ok"}`)).toEqual({
      decision: "approve", confidence: 0.9, reason: "ok",
    });
  });
  test("tolerates a ```json fence and leading prose", () => {
    const out = "Sure, here is my verdict:\n```json\n{\"decision\":\"reject\",\"confidence\":0.3,\"reason\":\"no\"}\n```";
    expect(extractJsonObjectLoose(out)).toEqual({ decision: "reject", confidence: 0.3, reason: "no" });
  });
  test("returns null on output with no JSON object", () => {
    expect(extractJsonObjectLoose("I cannot answer that.")).toBeNull();
  });
  test("returns null on a truncated/broken object", () => {
    expect(extractJsonObjectLoose(`{"decision":"approve",`)).toBeNull();
  });
});
