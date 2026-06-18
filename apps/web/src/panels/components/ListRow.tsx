/**
 * ListRow — full-width row chrome for the native row-list pattern.
 *
 * Matches the visual language from DeploymentsPanel / the Swift native panels:
 * - Subtle `#26272B` border + rounded corners
 * - Hover highlight (slightly lighter background)
 * - Optional expand chevron with accessible aria-expanded
 * - Optional `children` slot rendered below the row when expanded
 * - Optional bottom progress bar (for rollout progress etc.)
 *
 * All list panels (Deployments, Pods, …) should wrap their per-item markup
 * in this component so chrome stays consistent.
 */
import { ChevronRight, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent } from "@/components/ui/context-menu";

export interface ListRowProps {
  /** Unique key for the row — used as the React key. */
  rowKey: string;
  /** Whether the row is currently expanded. */
  isOpen: boolean;
  /** Called when the chevron or name is clicked to toggle expand. */
  onToggle: () => void;
  /** Row body content (everything right of the chevron). */
  children: ReactNode;
  /** Content shown below the row when `isOpen` is true. */
  expandedContent?: ReactNode;
  /**
   * Progress fraction (0…1) shown as a thin bar pinned to the bottom edge.
   * Omit / pass undefined for no bar.
   */
  progress?: number;
  /** Arbitrary left-edge overlay (e.g. redeploying glow). */
  overlay?: ReactNode;
  /**
   * Right-click menu items (`<ContextMenuItem>`/`<ContextMenuSeparator>`…). When
   * provided, right-clicking the row opens a context menu with these actions.
   */
  contextMenu?: ReactNode;
}

export function ListRow({
  rowKey,
  isOpen,
  onToggle,
  children,
  expandedContent,
  progress,
  overlay,
  contextMenu,
}: ListRowProps) {
  const cardClass = "relative overflow-hidden rounded-md";
  const cardStyle = {
    background: isOpen ? "var(--surface-elevated)" : "var(--surface-sunken)",
    border: "1px solid #26272B",
  } as const;

  const cardInner = (
    <>
      {/* Optional left-edge overlay (e.g. redeploying glow) */}
      {overlay}

      <div className="relative flex items-center gap-2 px-2.5 py-2">
        {/* Expand/collapse chevron */}
        <button
          type="button"
          onClick={onToggle}
          aria-label={isOpen ? "Collapse" : "Expand"}
          aria-expanded={isOpen}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          {isOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </button>

        {/* Row body */}
        {children}
      </div>

      {/* Optional bottom progress bar */}
      {progress !== undefined && (
        <div
          className="absolute bottom-0 left-0 right-0"
          style={{ height: 2.5, background: "var(--border-strong)" }}
        >
          <div
            style={{
              height: "100%",
              width: `${Math.round(progress * 100)}%`,
              background: "var(--status-running)",
              transition: "width 0.4s ease",
            }}
          />
        </div>
      )}
    </>
  );

  return (
    <>
      {/* Main row card — wrapped in a right-click context menu when items given. */}
      {contextMenu ? (
        <ContextMenu>
          <ContextMenuTrigger className={cardClass} style={cardStyle} data-row-key={rowKey}>
            {cardInner}
          </ContextMenuTrigger>
          <ContextMenuContent>{contextMenu}</ContextMenuContent>
        </ContextMenu>
      ) : (
        <div className={cardClass} style={cardStyle} data-row-key={rowKey}>
          {cardInner}
        </div>
      )}

      {/* Expanded detail panel */}
      {isOpen && expandedContent && (
        <div
          className="rounded-b-md border-x border-b px-6 py-3"
          style={{ borderColor: "var(--border-subtle)", background: "var(--surface-primary)" }}
        >
          {expandedContent}
        </div>
      )}
    </>
  );
}
