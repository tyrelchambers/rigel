import { test, expect } from "bun:test";
import { issueSession, sessionValid } from "./session";

const NOW = 1_700_000_000_000;

test("a freshly issued session validates", () => {
  expect(sessionValid(issueSession(NOW), NOW)).toBe(true);
});

test("a session is rejected once expired", () => {
  const value = issueSession(NOW);
  // 8 days later (TTL is 7d)
  expect(sessionValid(value, NOW + 8 * 24 * 60 * 60 * 1000)).toBe(false);
});

test("a tampered signature is rejected", () => {
  const value = issueSession(NOW);
  const dot = value.lastIndexOf(".");
  const tampered = value.slice(0, dot + 1) + "deadbeef";
  expect(sessionValid(tampered, NOW)).toBe(false);
});

test("a tampered expiry (without re-signing) is rejected", () => {
  const value = issueSession(NOW);
  const mac = value.slice(value.lastIndexOf(".") + 1);
  const forged = `${NOW + 999_999_999}.${mac}`;
  expect(sessionValid(forged, NOW)).toBe(false);
});

test("empty / malformed values are rejected", () => {
  expect(sessionValid(undefined, NOW)).toBe(false);
  expect(sessionValid("", NOW)).toBe(false);
  expect(sessionValid("nope", NOW)).toBe(false);
});
