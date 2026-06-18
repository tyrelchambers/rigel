import { test, expect } from "vitest";
import { checkAuth } from "./auth";

test("open when no token configured", () => {
  expect(checkAuth(undefined, null)).toBe(true);
});
test("requires matching bearer when token set", () => {
  expect(checkAuth("Bearer s3cret", "s3cret")).toBe(true);
  expect(checkAuth("Bearer wrong", "s3cret")).toBe(false);
  expect(checkAuth(undefined, "s3cret")).toBe(false);
});
