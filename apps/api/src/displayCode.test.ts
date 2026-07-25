import { test, expect } from "vitest";
import { displayCodeFor } from "./displayCode";

test("is deterministic for a given poll-token hash", () => {
  expect(displayCodeFor("abc123")).toBe(displayCodeFor("abc123"));
});

test("differs for different hashes", () => {
  expect(displayCodeFor("abc123")).not.toBe(displayCodeFor("abc124"));
});

test("is formatted XXXX-XXXX", () => {
  expect(displayCodeFor("abc123")).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
});

test("never emits the ambiguous characters I, L, O or U", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) for (const ch of displayCodeFor(`hash-${i}`)) seen.add(ch);
  for (const bad of ["I", "L", "O", "U"]) expect(seen.has(bad)).toBe(false);
});

test("does not leak the input", () => {
  expect(displayCodeFor("abc123")).not.toContain("abc");
});
