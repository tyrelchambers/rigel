/**
 * TagPill — small accent/purple pill for image tags, identity labels, etc.
 *
 * Uses the theme accent color (#38BDF8) with 15% background, matching
 * the native Swift `ActionButtonStrip` and the tag chips in DeploymentsPanel.
 */

interface TagPillProps {
  /** The text to display inside the pill. */
  label: string;
  /** Optional tooltip shown on hover. */
  title?: string;
}

export function TagPill({ label, title }: TagPillProps) {
  return (
    <span
      title={title}
      style={{
        fontFamily: "ui-monospace, monospace",
        fontSize: 10,
        fontWeight: 500,
        color: "var(--accent-primary)",
        background: "var(--accent-dim)",
        padding: "1px 5px",
        borderRadius: 4,
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
}
