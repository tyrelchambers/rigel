import { describe, it, expect } from "vitest";
import { checkSessionSecret, accessAllowed } from "./sessionAuth";

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
  it("rejects a same-codeunit-length but different-byte-length value without throwing", () => {
    // "s3cr3é" is 6 UTF-16 code units but 7 UTF-8 bytes — the old char-length
    // guard let it reach timingSafeEqual, which throws on unequal byte lengths.
    expect(checkSessionSecret("s3cr3é", "s3cr3t")).toBe(false);
    expect(checkSessionSecret("é", "s3cr3t")).toBe(false);
  });
});

describe("accessAllowed", () => {
  it("is fully open when no secret is configured (web-dev/Docker)", () => {
    expect(accessAllowed(null, "", false)).toBe(true);
    expect(accessAllowed("whatever", "", false)).toBe(true);
  });
  it("requires the session secret AND signed-in when configured", () => {
    expect(accessAllowed("sekret", "sekret", true)).toBe(true);
    expect(accessAllowed("sekret", "sekret", false)).toBe(false);
    expect(accessAllowed("wrong", "sekret", true)).toBe(false);
    expect(accessAllowed(null, "sekret", true)).toBe(false);
  });
});
