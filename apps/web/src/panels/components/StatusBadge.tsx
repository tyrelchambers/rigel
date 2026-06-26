/**
 * StatusBadge — right-aligned "x/y" or label badge.
 *
 * Color rules matching the native theme tokens:
 *   - "healthy" (green):  #10B981 with 12% bg
 *   - "error"   (red):    #EF4444 with 12% bg
 *   - "pending" (amber):  #F59E0B with 12% bg
 *   - "neutral" (gray):   #A1A1AA with 12% bg (default)
 *
 * Mirrors the Swift `StatusPill` and the ready-badge in DeploymentsPanel.
 */

export type StatusBadgeVariant = "healthy" | "error" | "pending" | "neutral";

interface StatusBadgeProps {
  /** Text displayed inside the badge (e.g. "3/3", "Running", "2"). */
  label: string;
  /** Semantic variant that determines the color. Defaults to "neutral". */
  variant?: StatusBadgeVariant;
  /** Optional tooltip. */
  title?: string;
  /** Allow long labels to wrap instead of staying on one line. Defaults to false. */
  wrap?: boolean;
}

const COLORS: Record<StatusBadgeVariant, { text: string; bg: string }> = {
  healthy: { text: "var(--status-running)", bg: "rgba(16,185,129,0.12)" },
  error:   { text: "var(--status-failed)", bg: "rgba(239,68,68,0.12)" },
  pending: { text: "var(--status-pending)", bg: "rgba(245,158,11,0.12)" },
  neutral: { text: "var(--fg-secondary)", bg: "rgba(161,161,170,0.12)" },
};

export function StatusBadge({ label, variant = "neutral", title, wrap = false }: StatusBadgeProps) {
  const { text, bg } = COLORS[variant];
  return (
    <span
      title={title}
      style={{
        fontFamily: "ui-monospace, monospace",
        fontSize: 11,
        fontWeight: 500,
        color: text,
        background: bg,
        padding: "1px 6px",
        borderRadius: 4,
        whiteSpace: wrap ? "normal" : "nowrap",
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
}
