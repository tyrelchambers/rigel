/**
 * PanelSearch — the standardized search input for panel headers.
 *
 * Reproduces the "Subpanel Header" search field: a bordered, sunken pill with a
 * leading search icon and a borderless text input. Controlled via `value` /
 * `onValueChange` so panels keep owning their filter state.
 */
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faMagnifyingGlass } from "@awesome.me/kit-6050953220/icons/classic/solid";

interface PanelSearchProps {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  /** Overrides the default 280px width (e.g. "w-56" for tighter headers). */
  className?: string;
  ariaLabel?: string;
}

export function PanelSearch({
  value,
  onValueChange,
  placeholder = "Search…",
  className = "w-[280px]",
  ariaLabel,
}: PanelSearchProps) {
  return (
    <div
      className={`flex items-center gap-[9px] rounded-[6px] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-[13px] py-[9px] focus-within:ring-2 focus-within:ring-ring/50 ${className}`}
    >
      <FontAwesomeIcon icon={faMagnifyingGlass} aria-hidden className="size-[15px] shrink-0 text-[color:var(--fg-tertiary)]" />
      <input
        type="text"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        className="w-full bg-transparent text-xs text-foreground outline-none placeholder:text-[color:var(--fg-tertiary)]"
      />
    </div>
  );
}
