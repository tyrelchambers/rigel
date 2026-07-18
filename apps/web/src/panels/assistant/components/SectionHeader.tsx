import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/** Shared Overview section header: an accent icon tile, a title with an optional
 *  inline badge, a one-line subtitle, and a right-aligned actions slot. Keeps the
 *  Last report / Recent activity / Resources sections visually uniform. */
export function SectionHeader({
  icon: Icon,
  title,
  subtitle,
  actions,
}: {
  icon: LucideIcon;
  title: ReactNode;
  subtitle: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--accent-primary)_15%,transparent)]">
          <Icon className="size-4 text-[var(--accent-primary)]" />
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-2 text-base font-bold text-[var(--fg-primary)]">
            {title}
          </div>
          <p className="truncate text-xs text-[var(--fg-tertiary)]">{subtitle}</p>
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
