import { describe, it, expect } from "vitest";
import { sanitizeName } from "./names";

describe("sanitizeName", () => {
  it("lowercases and dashes non-alphanumerics", () => {
    expect(sanitizeName("My_App")).toBe("my-app");
    expect(sanitizeName("web")).toBe("web");
  });
  it("trims and collapses leading/trailing/repeated dashes", () => {
    expect(sanitizeName("_svc_")).toBe("svc");
    expect(sanitizeName("a__b")).toBe("a-b");
  });
  it("falls back to 'app' for empty results", () => {
    expect(sanitizeName("___")).toBe("app");
  });
});
