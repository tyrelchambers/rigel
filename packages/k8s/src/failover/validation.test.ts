import { describe, expect, it } from "vitest";
import { validationPassed } from "./validation";

const api = { ok: true as const, email: "me@example.com" };

describe("validationPassed", () => {
  it("passes on a good token with no object store configured", () => {
    expect(validationPassed({ ok: true, api })).toBe(true);
  });

  it("fails on a bad token", () => {
    expect(validationPassed({ ok: false, api: { ok: false, status: 401, error: "no" } })).toBe(false);
  });

  it("fails when the object store was given and rejected", () => {
    expect(
      validationPassed({ ok: false, api, objectStore: { ok: false, code: "addressing", error: "no" } }),
    ).toBe(false);
  });

  it("passes when the object store answered, even with no bucket yet", () => {
    expect(
      validationPassed({ ok: true, api, objectStore: { ok: true, bucketExists: false, insideSourceCluster: false } }),
    ).toBe(true);
  });
});
