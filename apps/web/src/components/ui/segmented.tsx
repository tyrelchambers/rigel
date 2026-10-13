import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  ariaLabel?: string;
  dot?: string;
}

const VARIANTS = {
  sunken: {
    track: "gap-0.5 bg-[var(--surface-sunken)]",
    segment: "rounded",
    selected: "bg-[var(--border-strong)] font-semibold text-[var(--fg-primary)]",
    idle: "font-medium text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]",
  },
  raised: {
    track: "gap-[3px] bg-white/[0.04]",
    segment: "rounded-sm",
    selected: "border border-[var(--border-subtle)] bg-white/[0.08] font-semibold text-[var(--fg-primary)]",
    idle: "text-[var(--fg-tertiary)] hover:text-[var(--fg-primary)]",
  },
};

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  variant = "sunken",
  disabled,
  ariaLabel,
  className,
  segmentClassName,
}: {
  value: T | null;
  onChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  variant?: keyof typeof VARIANTS;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  segmentClassName?: string;
}) {
  const v = VARIANTS[variant];
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn("flex rounded-md border border-[var(--border-subtle)] p-[3px]", v.track, className)}
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            disabled={disabled}
            aria-pressed={selected}
            aria-label={o.ariaLabel}
            onClick={() => onChange(o.value)}
            className={cn(
              "flex items-center justify-center gap-1.5 py-1.5 text-xs transition-colors disabled:opacity-60",
              v.segment,
              segmentClassName,
              selected ? v.selected : v.idle,
            )}
          >
            {selected && o.dot && <span className={cn("size-1.5 rounded-full", o.dot)} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
