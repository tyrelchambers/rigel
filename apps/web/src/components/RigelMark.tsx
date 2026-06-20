/**
 * RigelMark — the Rigel constellation logo, inline.
 *
 * Source of truth: /assets/brand/logo-constellation.svg. That file fills with
 * dark navy (#0B1F3A), which is invisible on the app's dark surfaces, so this
 * draws stroke/fill with `currentColor` and lets the parent set the color.
 */
import type { CSSProperties } from "react";

export function RigelMark({
  size = 15,
  style,
  className,
}: {
  size?: number;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 132 132"
      fill="none"
      className={className}
      style={{ flexShrink: 0, ...style }}
      aria-hidden
    >
      <path
        d="M30 46l68-16 4 66-60 6z m68-16l-56 72"
        stroke="currentColor"
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="30" cy="46" r="7" fill="currentColor" />
      <circle cx="98" cy="30" r="7" fill="currentColor" />
      <circle cx="102" cy="96" r="7" fill="currentColor" />
      <circle cx="42" cy="102" r="7" fill="currentColor" />
    </svg>
  );
}
