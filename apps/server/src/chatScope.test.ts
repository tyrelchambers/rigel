import { test, expect } from "vitest";
import { parseChatScope, resolveReadContexts } from "./chatScope";

test("parseChatScope tolerates untrusted input, defaulting to active", () => {
  expect(parseChatScope(undefined)).toBe("active");
  expect(parseChatScope("active")).toBe("active");
  expect(parseChatScope("all")).toBe("all");
  expect(parseChatScope("garbage")).toBe("active");
  expect(parseChatScope({ contexts: ["a", "b"] })).toEqual({ contexts: ["a", "b"] });
  expect(parseChatScope({ contexts: ["a", 3, null] })).toEqual({ contexts: ["a"] });
  expect(parseChatScope({ nope: 1 })).toBe("active");
});

const ALL = ["dev", "prod", "stage"];

test("resolveReadContexts: active scope → just the active context", () => {
  expect(resolveReadContexts("active", "dev", ALL)).toEqual(["dev"]);
  expect(resolveReadContexts("active", null, ALL)).toEqual([]);
});

test("resolveReadContexts: all scope → every context, active first, deduped", () => {
  expect(resolveReadContexts("all", "prod", ALL)).toEqual(["prod", "dev", "stage"]);
  expect(resolveReadContexts("all", null, ALL)).toEqual(["dev", "prod", "stage"]);
});

test("resolveReadContexts: pick scope → real picked contexts, active first if included", () => {
  expect(resolveReadContexts({ contexts: ["stage", "prod"] }, "prod", ALL)).toEqual(["prod", "stage"]);
  expect(resolveReadContexts({ contexts: ["prod", "stage"] }, "dev", ALL)).toEqual(["prod", "stage"]);
  expect(resolveReadContexts({ contexts: ["prod", "ghost"] }, "dev", ALL)).toEqual(["prod"]);
  expect(resolveReadContexts({ contexts: ["ghost"] }, "dev", ALL)).toEqual(["dev"]);
  expect(resolveReadContexts({ contexts: [] }, "dev", ALL)).toEqual(["dev"]);
});
