// Shared segmented-rail tabs: a subtle lighter-gray rounded rail with rounded
// tab buttons; the active tab gets a faint filled pill. Used by the Helm tab,
// the TabModal header, and the catalog scope control.
import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

export interface SegmentedTab {
  id: string;
  label: string;
  badge?: number;
}

interface SegmentedTabsProps {
  tabs: SegmentedTab[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
}

export function SegmentedTabs({ tabs, active, onChange, className }: SegmentedTabsProps) {
  const rail: CSSProperties = {
    display: "inline-flex",
    gap: 3,
    padding: 3,
    borderRadius: 10,
    background: "rgba(255,255,255,0.04)",
  };
  return (
    <div role="tablist" style={rail} className={className}>
      {tabs.map((t) => {
        const isActive = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(t.id)}
            className="flex items-center gap-1.5 transition-colors"
            style={{
              padding: "6px 12px",
              borderRadius: 7,
              fontSize: 13,
              fontWeight: isActive ? 600 : 500,
              color: isActive ? "var(--fg-primary)" : "var(--fg-tertiary)",
              background: isActive ? "rgba(255,255,255,0.08)" : "transparent",
            }}
          >
            {t.label}
            {t.badge != null && t.badge > 0 && (
              <span
                className={cn("rounded-full px-1.5 text-[10px] font-semibold tabular-nums")}
                style={{ background: "var(--border-strong)", color: "var(--fg-secondary)" }}
              >
                {t.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
