import { describe, expect, test } from "vitest";
import { errorResult, type ProviderResult } from "./types.js";

describe("errorResult", () => {
  test("builds a fail-closed result carrying the message", () => {
    const r: ProviderResult = errorResult("no GEMINI_API_KEY in env");
    expect(r.isError).toBe(true);
    expect(r.errorMessage).toBe("no GEMINI_API_KEY in env");
    expect(r.text).toBe("");
    expect(r.costUsd).toBe(0);
    expect(r.structuredOutput).toBeUndefined();
    expect(r.sessionId).toBeUndefined();
  });
});
