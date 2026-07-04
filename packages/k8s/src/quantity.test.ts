// packages/k8s/src/quantity.test.ts
import { describe, test, expect } from "vitest";
import { parseQuantity } from "./quantity";

describe("parseQuantity", () => {
  test("CPU strings → cores", () => {
    expect(parseQuantity("100m", "cpu")).toBe(0.1);
    expect(parseQuantity("1500m", "cpu")).toBe(1.5);
    expect(parseQuantity("1", "cpu")).toBe(1);
    expect(parseQuantity("4", "cpu")).toBe(4);
    expect(parseQuantity("250m", "cpu")).toBe(0.25);
    expect(parseQuantity("1.5", "cpu")).toBe(1.5);
  });
  test("memory strings → bytes", () => {
    expect(parseQuantity("512Mi", "memory")).toBe(536870912);
    expect(parseQuantity("1Gi", "memory")).toBe(1073741824);
    expect(parseQuantity("512Ki", "memory")).toBe(524288);
    expect(parseQuantity("1G", "memory")).toBe(1000000000);
  });
  test("malformed → 0", () => {
    expect(parseQuantity("", "cpu")).toBe(0);
    expect(parseQuantity("nonsense", "memory")).toBe(0);
  });
});
