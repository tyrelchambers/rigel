/**
 * Pure helper for SVG mini-chart path computation. Mirrors Sparkline.swift.
 * All functions are side-effect free and unit-tested (sparkline.test.ts).
 */

export interface Point {
  x: number;
  y: number;
}

/**
 * Map a series of values to SVG (x, y) coordinates within a bounding box of
 * `width × height`. Auto-scales to the max value in the series (matching the
 * native Swift Sparkline). A 1px inset is preserved at the top and bottom so
 * the stroke never clips the viewport.
 *
 * Returns an empty array when `values` has fewer than 2 samples.
 */
export function valuesToPoints(
  values: number[],
  width: number,
  height: number,
): Point[] {
  if (values.length < 2) return [];
  const maxV = Math.max(...values, 1e-9);
  return values.map((v, i) => ({
    x: (i / (values.length - 1)) * width,
    // y=0 is top in SVG; highest value → y near 1, lowest → y near height-1.
    y: height - (v / maxV) * (height - 2) - 1,
  }));
}

/**
 * Build an SVG `d` attribute polyline path from the given points. Returns an
 * empty string when `points` is empty.
 */
export function pointsToLinePath(points: Point[]): string {
  if (points.length === 0) return "";
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
    .join(" ");
}

/**
 * Build an SVG `d` attribute for the closed fill area below the polyline
 * (mirrors Swift's `fillPath`): line down from last point to bottom-right,
 * across to bottom-left, closed.
 */
export function pointsToFillPath(points: Point[], height: number): string {
  if (points.length === 0) return "";
  const line = pointsToLinePath(points);
  const last = points[points.length - 1];
  const first = points[0];
  return `${line} L${last.x.toFixed(2)},${height} L${first.x.toFixed(2)},${height} Z`;
}
