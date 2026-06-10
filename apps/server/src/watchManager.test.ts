import { test, expect } from "bun:test";
import { applyEvent } from "./watchManager";

test("ADDED then MODIFIED upserts; DELETED removes", () => {
  const cache = new Map<string, any>();
  applyEvent(cache, { type: "ADDED", object: { metadata: { name: "a" }, spec: 1 } });
  applyEvent(cache, { type: "MODIFIED", object: { metadata: { name: "a" }, spec: 2 } });
  expect(cache.get("a").spec).toBe(2);
  applyEvent(cache, { type: "DELETED", object: { metadata: { name: "a" } } });
  expect(cache.has("a")).toBe(false);
});
