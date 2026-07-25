import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChevronRight } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { cn } from "@/lib/utils";

export function OptionCard({
  icon,
  title,
  desc,
  hero,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  hero?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-4 rounded-xl border p-4 text-left transition-colors",
        hero
          ? "border-[color-mix(in_oklab,var(--accent-primary)_35%,transparent)] bg-[var(--accent-dim)] hover:bg-[color-mix(in_oklab,var(--accent-primary)_22%,transparent)]"
          : "border-[var(--border-subtle)] bg-[var(--surface-elevated)] hover:bg-white/[0.04]",
      )}
    >
      <span
        className={cn(
          "flex size-11 shrink-0 items-center justify-center rounded-lg",
          hero ? "bg-[var(--accent-dim)] text-[var(--accent-primary)]" : "bg-white/[0.06] text-[var(--fg-secondary)]",
        )}
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="text-sm font-semibold text-[var(--fg-primary)]">{title}</span>
          {hero && (
            <span className="rounded-full border border-[color-mix(in_oklab,var(--accent-primary)_40%,transparent)] px-2 py-0.5 font-mono text-3xs font-semibold tracking-widest text-[var(--accent-primary)]">
              RECOMMENDED
            </span>
          )}
        </span>
        <span className="text-xs text-[var(--fg-secondary)]">{desc}</span>
      </span>
      <FontAwesomeIcon icon={faChevronRight} className="size-4 shrink-0 text-[var(--fg-tertiary)]" />
    </button>
  );
}
