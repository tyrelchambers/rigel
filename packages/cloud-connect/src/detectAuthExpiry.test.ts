import { test, expect } from "vitest";
import { detectAuthExpiry } from "./detectAuthExpiry";

test("matches a DigitalOcean auth-expiry stderr (case-insensitive)", () => {
  expect(detectAuthExpiry("digitalocean", "Error: Unable to authenticate you")).toBe(true);
  expect(detectAuthExpiry("digitalocean", "the server responded with status 401")).toBe(true);
});

test("does not match an unrelated error", () => {
  expect(detectAuthExpiry("digitalocean", "connection refused")).toBe(false);
});

test("returns false for an unknown provider", () => {
  expect(detectAuthExpiry("aws", "401")).toBe(false);
});
