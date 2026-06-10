import { describe, it, expect } from "vitest";
import { valuesToPoints, pointsToLinePath, pointsToFillPath } from "./sparklineHelpers";

describe("valuesToPoints", () => {
  it("returns empty for fewer than 2 values", () => {
    expect(valuesToPoints([], 100, 20)).toEqual([]);
    expect(valuesToPoints([5], 100, 20)).toEqual([]);
  });

  it("maps two values to x=0 and x=width", () => {
    const pts = valuesToPoints([0, 1], 100, 20);
    expect(pts).toHaveLength(2);
    expect(pts[0].x).toBe(0);
    expect(pts[1].x).toBe(100);
  });

  it("highest value maps near bottom of y range (y close to 1)", () => {
    // Single peak at the end
    const pts = valuesToPoints([0, 10], 100, 20);
    // pt[1] is the max → y = height - (v/maxV)*(height-2) - 1
    //                       = 20  - (10/10)*(18)      - 1 = 1
    expect(pts[1].y).toBeCloseTo(1, 5);
  });

  it("zero value maps to bottom of y range (y = height - 1)", () => {
    const pts = valuesToPoints([0, 10], 100, 20);
    // pt[0] is 0 → y = 20 - 0 - 1 = 19
    expect(pts[0].y).toBeCloseTo(19, 5);
  });

  it("all equal values map to the same y", () => {
    const pts = valuesToPoints([5, 5, 5], 100, 20);
    expect(pts[0].y).toBe(pts[1].y);
    expect(pts[1].y).toBe(pts[2].y);
  });

  it("x positions are evenly spaced", () => {
    const pts = valuesToPoints([1, 2, 3, 4, 5], 100, 20);
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i].x - pts[i - 1].x).toBeCloseTo(25, 5);
    }
  });

  it("all-zero series auto-scales without division by zero", () => {
    const pts = valuesToPoints([0, 0, 0], 100, 20);
    // max is clamped to 1e-9 so y = height - 0 - 1 = height - 1 for all
    expect(pts.every((p) => p.y === 19)).toBe(true);
  });
});

describe("pointsToLinePath", () => {
  it("returns empty string for empty points", () => {
    expect(pointsToLinePath([])).toBe("");
  });

  it("starts with M for first point and L for subsequent", () => {
    const pts = [
      { x: 0, y: 10 },
      { x: 50, y: 5 },
      { x: 100, y: 2 },
    ];
    const d = pointsToLinePath(pts);
    expect(d.startsWith("M")).toBe(true);
    expect(d.includes("L")).toBe(true);
  });
});

describe("pointsToFillPath", () => {
  it("returns empty string for empty points", () => {
    expect(pointsToFillPath([], 20)).toBe("");
  });

  it("closes the path with Z", () => {
    const pts = [
      { x: 0, y: 10 },
      { x: 100, y: 5 },
    ];
    const d = pointsToFillPath(pts, 20);
    expect(d.endsWith("Z")).toBe(true);
  });

  it("contains height in bottom-close segment", () => {
    const pts = [
      { x: 0, y: 10 },
      { x: 100, y: 5 },
    ];
    const d = pointsToFillPath(pts, 20);
    // Should include ,20 for the bottom corners
    expect(d).toContain(",20");
  });
});
