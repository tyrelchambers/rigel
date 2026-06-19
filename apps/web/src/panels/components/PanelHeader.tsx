/**
 * PanelHeader — the unified header used by every list panel.
 *
 * A single full-bleed band, left-aligned, with one bottom border: the panel
 * title, an optional "?" tooltip describing the panel, the item-count chip,
 * a loading spinner, and right-aligned actions. Namespace selection lives in
 * the global header now, so this header no longer carries a namespace row.
 *
 * Panels render this as the fixed top of a full-height column, with the list
 * scrolling underneath, so the header stays put.
 */
import { LoaderCircle } from "lucide-react";
import { InfoTooltip } from "@/components/InfoTooltip";

interface PanelHeaderProps {
  title: string;
  subtitle?: string;
  /** Item count chip shown next to the title. */
  count?: number;
  /** Shows a spinner next to the title/count. */
  loading?: boolean;
  /** Right-aligned controls (search input, action buttons, …). */
  children?: React.ReactNode;
}

export function PanelHeader({ title, subtitle, count, loading, children }: PanelHeaderProps) {
  return (
    <div
      style={{ background: "var(--surface-elevated)", borderBottom: "1px solid #26272B", flexShrink: 0 }}
    >
      <div className="flex items-center gap-2 px-4 py-2">
        <span className="text-sm font-semibold leading-tight">{title}</span>
        {subtitle && <InfoTooltip label={subtitle} />}
        {count != null && (
          <span
            style={{
              fontFamily: "ui-monospace, monospace",
              fontSize: 11,
              color: "var(--fg-tertiary)",
              background: "var(--border-subtle)",
              padding: "2px 6px",
              borderRadius: 4,
            }}
          >
            {count}
          </span>
        )}
        {loading && (
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-label="loading" />
        )}
        {children && <div className="ml-auto flex items-center gap-2">{children}</div>}
      </div>
    </div>
  );
}
