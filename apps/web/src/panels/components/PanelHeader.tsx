/**
 * PanelHeader — the unified header used by every list panel.
 *
 * It combines the namespace selector ("main header") and the panel
 * title/subtitle/count + actions ("sub header") into ONE cohesive element:
 * a single full-bleed band, left-aligned, with one bottom border. On
 * namespace-scoped routes the namespace row appears above the title row; on
 * cluster-wide routes it is omitted and only the title row shows.
 *
 * Panels render this as the fixed top of a full-height column, with the list
 * scrolling underneath — so the header (and namespace selector) stays put.
 */
import { LoaderCircle } from "lucide-react";
import { NamespaceSelector, useIsNamespaceScoped } from "@/shell/NamespaceBar";

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
  const scoped = useIsNamespaceScoped();
  return (
    <div
      style={{ background: "var(--surface-elevated)", borderBottom: "1px solid #26272B", flexShrink: 0 }}
    >
      {scoped && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "10px 16px 0",
          }}
        >
          <NamespaceSelector />
        </div>
      )}
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex flex-col gap-0">
          <span className="text-sm font-semibold leading-tight">{title}</span>
          {subtitle && <span style={{ fontSize: 11, color: "var(--fg-tertiary)" }}>{subtitle}</span>}
        </div>
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
