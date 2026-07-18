// Composable segmented tabs (Pencil "Tab Bar" — Tab · single item, TabBar ·
// segmented container). A sunken, bordered rail holds rounded tab buttons; the
// active tab gets a faint filled pill, an accent-tinted icon, and its label in
// primary. Tabs optionally carry a leading icon and a trailing count badge.
//
// Composable API (preferred):
//   <TabBar value={tab} onValueChange={setTab}>
//     <Tab value="releases" icon={faRectangleList}>Releases</Tab>
//     <Tab value="browse" icon={faStore} badge={8}>Browse charts</Tab>
//   </TabBar>
import { createContext, use, type ReactNode } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { cn } from "@/lib/utils";

/** A leading tab icon: a Font Awesome icon definition. */
export type TabIcon = IconDefinition;

interface TabBarContextValue {
  value: string;
  onValueChange: (id: string) => void;
}

const TabBarContext = createContext<TabBarContextValue | null>(null);

/** The segmented container. Provides the active value + change handler to its Tabs. */
export function TabBar({
  value,
  onValueChange,
  className,
  children,
}: {
  value: string;
  onValueChange: (id: string) => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <TabBarContext value={{ value, onValueChange }}>
      <div
        role="tablist"
        className={cn(
          "inline-flex max-w-full items-center gap-[2px] overflow-x-auto rounded-md border p-[3px]",
          "border-[var(--border-subtle)] bg-[var(--surface-sunken)]",
          className,
        )}
      >
        {children}
      </div>
    </TabBarContext>
  );
}

/** A single tab. Reads its active state from the enclosing TabBar. */
export function Tab({
  value,
  icon: Icon,
  badge,
  disabled,
  className,
  children,
}: {
  value: string;
  icon?: TabIcon;
  /** Trailing count badge; hidden when null/0. */
  badge?: number;
  disabled?: boolean;
  /** Extra classes, e.g. `flex-1 justify-center` for full-width segments. */
  className?: string;
  children: ReactNode;
}) {
  const ctx = use(TabBarContext);
  if (!ctx) throw new Error("<Tab> must be rendered inside a <TabBar>");
  const isActive = ctx.value === value;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      disabled={disabled}
      onClick={() => ctx.onValueChange(value)}
      className={cn(
        "flex items-center gap-[7px] whitespace-nowrap rounded-[4px] px-3.5 py-[7px] text-xs transition-colors",
        "disabled:pointer-events-none disabled:opacity-50",
        isActive
          ? "bg-white/[0.08] font-semibold text-[var(--fg-primary)]"
          : "font-normal text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]",
        className,
      )}
    >
      {Icon && (
        <FontAwesomeIcon
          icon={Icon}
          aria-hidden
          className={cn("size-[15px] shrink-0", isActive ? "text-[var(--accent-primary)]" : "text-[var(--fg-tertiary)]")}
        />
      )}
      {children}
      {badge != null && badge > 0 && (
        <span
          className={cn(
            "rounded-full bg-white/[0.08] px-[7px] py-px font-mono text-2xs font-semibold tabular-nums",
            isActive ? "text-[var(--fg-primary)]" : "text-[var(--fg-secondary)]",
          )}
        >
          {badge}
        </span>
      )}
    </button>
  );
}
