import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface UpgradeBannerProps {
  onUpgrade?: () => void;
  onDismiss?: () => void;
  upgradeDisabled?: boolean;
}

/** Low-key, dismissible onboarding upsell. Non-blocking: a ghost "Maybe later"
 *  next to a solid accent "Upgrade to Pro". */
export function UpgradeBanner({ onUpgrade, onDismiss, upgradeDisabled }: UpgradeBannerProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[color-mix(in_oklab,var(--accent-primary)_18%,transparent)] bg-[color-mix(in_oklab,var(--accent-primary)_6%,transparent)] p-3.5">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-[color-mix(in_oklab,var(--accent-primary)_10%,transparent)]">
        <Sparkles className="size-[18px] text-[var(--accent-primary)]" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-semibold text-[var(--fg-primary)]">You're on the Free plan</span>
        <span className="text-xs text-[var(--fg-secondary)]">
          Unlock audits, cloud clusters, and the autonomous agent with Rigel Pro.
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {onDismiss && (
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Maybe later
          </Button>
        )}
        <Button size="sm" disabled={upgradeDisabled} onClick={onUpgrade}>
          Upgrade to Pro
        </Button>
      </div>
    </div>
  );
}
