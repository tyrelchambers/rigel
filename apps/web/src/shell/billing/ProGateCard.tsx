import { Sparkles, Zap, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface ProGateCardProps {
  icon: LucideIcon;
  title: string;
  body: string;
  onUpgrade?: () => void;
  upgradeDisabled?: boolean;
  seeIncluded?: { label: string; href: string };
}

/** Full-panel Pro gate: accent-ringed icon, PRO pill, title, body, and the
 *  primary "Upgrade to Pro" action. Price lives in Stripe, never here. */
export function ProGateCard({ icon: Icon, title, body, onUpgrade, upgradeDisabled, seeIncluded }: ProGateCardProps) {
  return (
    <div className="mx-auto flex w-full max-w-[440px] flex-col items-center gap-4 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-8 py-9 text-center">
      <div className="flex size-14 items-center justify-center rounded-full border border-[color-mix(in_oklab,var(--accent-primary)_18%,transparent)] bg-[color-mix(in_oklab,var(--accent-primary)_8%,transparent)]">
        <Icon className="size-6 text-[var(--accent-primary)]" />
      </div>

      <span className="inline-flex items-center gap-1.5 rounded-full bg-[color-mix(in_oklab,var(--accent-primary)_8%,transparent)] px-2.5 py-1 font-mono text-3xs font-medium uppercase tracking-[0.08em] text-[var(--accent-soft)]">
        <Sparkles className="size-3" />
        Pro feature
      </span>

      <div className="flex flex-col gap-2">
        <h3 className="text-xl font-bold leading-tight text-[var(--fg-primary)]">{title}</h3>
        <p className="text-sm leading-relaxed text-[var(--fg-secondary)]">{body}</p>
      </div>

      <Button
        size="lg"
        disabled={upgradeDisabled}
        onClick={onUpgrade}
        className="mt-1 shadow-[0_8px_28px_-8px_color-mix(in_oklab,var(--accent-primary)_55%,transparent)]"
      >
        <Zap className="size-4" />
        Upgrade to Pro
      </Button>

      {seeIncluded && (
        <a
          href={seeIncluded.href}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-[var(--fg-tertiary)] transition-colors hover:text-[var(--fg-secondary)]"
        >
          {seeIncluded.label}
        </a>
      )}
    </div>
  );
}
