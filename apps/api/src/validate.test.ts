import { test, expect } from "vitest";
import { parseSignup } from "./validate";

const valid = {
  installId: "11111111-1111-4111-8111-111111111111",
  name: "Jane Doe",
  email: "jane@acme.com",
  appVersion: "0.1.0",
  platform: "darwin",
};

test("accepts a valid payload and trims", () => {
  const r = parseSignup({ ...valid, name: "  Jane Doe  " });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.name).toBe("Jane Doe");
});

test("rejects non-object", () => {
  expect(parseSignup(null).ok).toBe(false);
  expect(parseSignup("x").ok).toBe(false);
});

test("rejects bad installId", () => {
  expect(parseSignup({ ...valid, installId: "not-a-uuid" }).ok).toBe(false);
});

test("rejects empty name and over-long name", () => {
  expect(parseSignup({ ...valid, name: "" }).ok).toBe(false);
  expect(parseSignup({ ...valid, name: "a".repeat(201) }).ok).toBe(false);
});

test("rejects malformed email", () => {
  expect(parseSignup({ ...valid, email: "nope" }).ok).toBe(false);
});

test("truncates appVersion/platform to 50 chars and tolerates missing", () => {
  const r = parseSignup({ ...valid, appVersion: "v".repeat(80), platform: undefined });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.value.appVersion.length).toBe(50);
    expect(r.value.platform).toBe("");
  }
});
