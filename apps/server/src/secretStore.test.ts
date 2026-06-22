import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "./secretStore";

// These tests run in plain Node (vitest), so `electron` is absent and safeStorage
// is unavailable — every path falls through to the plaintext fallback.
describe("encryptSecret", () => {
  it("is a passthrough when no keychain is available (no electron)", () => {
    expect(encryptSecret("sk-test-123")).toBe("sk-test-123");
  });

  it("returns empty/whitespace input unchanged", () => {
    expect(encryptSecret("")).toBe("");
    expect(encryptSecret("   ")).toBe("   ");
  });
});

describe("decryptSecret", () => {
  it("returns an unmarked (plaintext/legacy) value as-is", () => {
    expect(decryptSecret("sk-test-123")).toBe("sk-test-123");
  });

  it("returns '' for a marked value when the keychain can't decrypt it", () => {
    // "enc:v1:" + base64("foo") — marked, but no keychain to decrypt.
    expect(decryptSecret("enc:v1:Zm9v")).toBe("");
  });

  it("passes empties through", () => {
    expect(decryptSecret("")).toBe("");
  });

  it("round-trips through encrypt (plaintext fallback) without a keychain", () => {
    const stored = encryptSecret("round-trip");
    expect(stored).toBe("round-trip");
    expect(decryptSecret(stored)).toBe("round-trip");
  });
});
