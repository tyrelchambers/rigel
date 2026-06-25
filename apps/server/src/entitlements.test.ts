import { test, expect } from "vitest";
import { canConnect } from "./entitlements";

test("v1 allows connecting to every target (no enforcement yet)", () => {
  for (const t of ["digitalocean", "aws", "gcp", "azure", "import"] as const) {
    expect(canConnect(t)).toEqual({ allowed: true });
  }
});
