import { describe, it, expect } from "vitest";
import { checkSessionSecret } from "./sessionAuth";

describe("checkSessionSecret", () => {
  it("allows everything when no secret is configured (empty expected = disabled)", () => {
    expect(checkSessionSecret(null, "")).toBe(true);
    expect(checkSessionSecret("anything", "")).toBe(true);
    expect(checkSessionSecret(undefined, "")).toBe(true);
  });
  it("accepts an exact match", () => {
    expect(checkSessionSecret("s3cr3t", "s3cr3t")).toBe(true);
  });
  it("rejects a mismatch, missing, or wrong-length value when configured", () => {
    expect(checkSessionSecret("nope", "s3cr3t")).toBe(false);
    expect(checkSessionSecret(null, "s3cr3t")).toBe(false);
    expect(checkSessionSecret(undefined, "s3cr3t")).toBe(false);
    expect(checkSessionSecret("", "s3cr3t")).toBe(false);
    expect(checkSessionSecret("s3cr3tX", "s3cr3t")).toBe(false);
  });
});
