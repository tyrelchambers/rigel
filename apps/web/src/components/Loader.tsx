/**
 * Loader — the app's standard loading indicator: the Rigel mark drawing itself
 * on a loop. This is the one spinner; replace ad-hoc lucide spinners with it.
 * Inherits its color from the surrounding text via `currentColor` unless `color`
 * is set. `role="status"` + `aria-label` keep it accessible.
 */
import type { CSSProperties } from "react";
import { RigelMark } from "@/components/RigelMark";

export function Loader({
  size = 16,
  color,
  className,
  style,
  label = "Loading",
}: {
  size?: number;
  color?: string;
  className?: string;
  style?: CSSProperties;
  label?: string;
}) {
  return (
    <span
      role="status"
      aria-label={label}
      className={className}
      style={{ display: "inline-flex", lineHeight: 0, ...style }}
    >
      <RigelMark size={size} loading loop glow={false} color={color ?? "currentColor"} />
    </span>
  );
}
