/**
 * PanelHeader — the unified header used by every list panel.
 *
 * Reproduces the "Subpanel Header" design: a bold title, an optional help
 * tooltip, a mono count pill, a loading spinner, and a right-aligned slot for
 * search + actions. Rendered as a full-bleed band (one bottom border) that
 * anchors the fixed top of a panel while its list scrolls underneath.
 */
import { Loader } from "@/components/Loader";
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
    <div className="flex-shrink-0 border-b border-[var(--border-subtle)] bg-card">
      <div className="flex items-center gap-[9px] px-5 py-3">
        <h1 className="font-heading text-lg leading-[1.1] font-semibold tracking-[-0.3px] text-foreground">{title}</h1>
        {subtitle && <InfoTooltip label={subtitle} />}
        {count != null && (
          <span className="rounded-[4px] border border-[var(--border-subtle)] bg-white/5 px-[9px] py-[2px] font-mono text-xs font-semibold text-muted-foreground">
            {count}
          </span>
        )}
        {loading && <Loader size={16} className="text-muted-foreground" label="loading" />}
        {children && <div className="ml-auto flex items-center gap-2.5">{children}</div>}
      </div>
    </div>
  );
}
