import { test, expect } from "vitest";
import { normalizeEmail, parsePollBody, parseRequestBody } from "./authValidate";

test("normalizeEmail lowercases and trims", () => {
  expect(normalizeEmail("  Foo@X.COM ")).toBe("foo@x.com");
});

test("parseRequestBody accepts a valid email, canonicalized", () => {
  expect(parseRequestBody({ email: "Jane@Acme.com" })).toEqual({ ok: true, email: "jane@acme.com" });
});

test("parseRequestBody rejects a bad email", () => {
  expect(parseRequestBody({ email: "nope" }).ok).toBe(false);
  expect(parseRequestBody({}).ok).toBe(false);
  expect(parseRequestBody(null).ok).toBe(false);
});

test("parsePollBody accepts a trimmed non-empty token", () => {
  expect(parsePollBody({ pollToken: "  abc123  " })).toEqual({ ok: true, pollToken: "abc123" });
});

test("parsePollBody rejects junk", () => {
  expect(parsePollBody({})).toEqual({ ok: false });
  expect(parsePollBody({ pollToken: "" })).toEqual({ ok: false });
  expect(parsePollBody({ pollToken: "   " })).toEqual({ ok: false });
  expect(parsePollBody({ pollToken: 7 })).toEqual({ ok: false });
  expect(parsePollBody(null)).toEqual({ ok: false });
  expect(parsePollBody({ pollToken: "x".repeat(600) })).toEqual({ ok: false });
});
