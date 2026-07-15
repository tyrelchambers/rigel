import { Lock } from "lucide-react";

/** Small "PRO" pill (accent-tinted, lock icon). */
export function ProPill() {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-[color-mix(in_oklab,var(--accent-primary)_8%,transparent)] px-1.5 py-0.5 font-mono text-3xs font-semibold uppercase tracking-wide text-[var(--accent-soft)]">
      <Lock className="size-3" />
      Pro
    </span>
  );
}

/** Inline row-level gate: a PRO pill plus a right-aligned accent "Upgrade"
 *  text button. Drop in where an unlocked row would render its run action. */
export function ProLockRow({ onUpgrade }: { onUpgrade?: () => void }) {
  return (
    <div className="flex shrink-0 items-center gap-2.5">
      <ProPill />
      {onUpgrade && (
        <button
          type="button"
          onClick={onUpgrade}
          className="text-xs font-semibold text-[var(--accent-primary)] transition-colors hover:text-[var(--accent-soft)]"
        >
          Upgrade
        </button>
      )}
    </div>
  );
}
