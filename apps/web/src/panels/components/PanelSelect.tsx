/**
 * PanelSelect — the standardized dropdown for panel headers.
 *
 * Mirrors PanelSearch's chrome (bordered, sunken pill, matching padding/height)
 * so filter selects line up with the search field. Native appearance is stripped
 * for a custom chevron, keeping every header select pixel-consistent. Controlled
 * via `value` / `onValueChange`.
 */
import type { ReactNode } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChevronDown } from "@awesome.me/kit-6050953220/icons/classic/solid";

interface PanelSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  ariaLabel: string;
  /** Width/spacing overrides (e.g. "max-w-44"). */
  className?: string;
  children: ReactNode;
}

export function PanelSelect({ value, onValueChange, ariaLabel, className = "", children }: PanelSelectProps) {
  return (
    <div
      className={`relative flex items-center rounded-[6px] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] focus-within:ring-2 focus-within:ring-ring/50 ${className}`}
    >
      <select
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        aria-label={ariaLabel}
        className="w-full appearance-none bg-transparent py-[9px] pl-[13px] pr-8 text-xs text-foreground outline-none"
      >
        {children}
      </select>
      <FontAwesomeIcon
        icon={faChevronDown}
        aria-hidden
        className="pointer-events-none absolute right-[11px] size-[11px] text-[color:var(--fg-tertiary)]"
      />
    </div>
  );
}
