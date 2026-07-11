import { describe, expect, it } from "vitest";
import { resolveRequestContext } from "./requestContext";

describe("resolveRequestContext", () => {
  it("prefers a non-empty header over the boot context", () => {
    expect(resolveRequestContext("prod", "boot")).toBe("prod");
  });

  it("trims surrounding whitespace from the header", () => {
    expect(resolveRequestContext("  prod  ", "boot")).toBe("prod");
  });

  it("falls back to boot context for an empty header", () => {
    expect(resolveRequestContext("", "boot")).toBe("boot");
  });

  it("falls back to boot context for a whitespace-only header", () => {
    expect(resolveRequestContext("   ", "boot")).toBe("boot");
  });

  it("falls back to boot context for a null header", () => {
    expect(resolveRequestContext(null, "boot")).toBe("boot");
  });

  it("falls back to boot context for an undefined header", () => {
    expect(resolveRequestContext(undefined, "boot")).toBe("boot");
  });

  it("returns null when the header is absent and boot context is null", () => {
    expect(resolveRequestContext(null, null)).toBeNull();
  });
});
