/**
 * Sparkline — a tiny SVG mini line chart. Mirrors Sparkline.swift:
 *   - Auto-scales to max value in the series.
 *   - Subtle area fill below the line (12% opacity).
 *   - No axes, labels, or ticks.
 *   - Returns null (renders nothing) when fewer than 2 samples.
 */
import { valuesToPoints, pointsToLinePath, pointsToFillPath } from "./sparklineHelpers";

interface SparklineProps {
  /** Data series. Needs at least 2 values to render. */
  values: number[];
  /** Stroke + fill color (default: #A855F7 — the accent purple). */
  color?: string;
  /** Width in px (default: 64). */
  width?: number;
  /** Height in px (default: 20). */
  height?: number;
  className?: string;
}

export function Sparkline({
  values,
  color = "#A855F7",
  width = 64,
  height = 20,
  className,
}: SparklineProps) {
  const points = valuesToPoints(values, width, height);
  if (points.length < 2) return null;

  const linePath = pointsToLinePath(points);
  const fillPath = pointsToFillPath(points, height);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      aria-hidden="true"
      style={{ display: "block", overflow: "visible" }}
    >
      {/* Area fill — 12% opacity, matching the native sparkline */}
      <path
        d={fillPath}
        fill={color}
        fillOpacity={0.12}
        stroke="none"
      />
      {/* Line — 1.2px stroke width matching the native sparkline */}
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth={1.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
