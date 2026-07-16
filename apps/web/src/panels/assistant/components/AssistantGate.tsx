import { Lock, Moon, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAssistantCtx } from "../AssistantContext";
import { useUpgrade } from "@/shell/UpgradeContext";

export function AssistantGate() {
  const { d } = useAssistantCtx();
  const { openUpgrade } = useUpgrade();
  const count = d.clusterState?.audit?.length ?? 0;
  const rows = Math.min(count, 3);
  return (
    <div className="mx-auto max-w-2xl">
      <div className="flex flex-col gap-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-[22px]">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex size-[38px] shrink-0 items-center justify-center rounded-[10px] bg-[var(--accent-dim)]">
              <Moon className="size-[18px] text-[var(--accent-primary)]" />
            </div>
            <div className="flex flex-col gap-0.5">
              <p className="font-heading text-base font-semibold text-[var(--fg-primary)]">While you were away</p>
              <p className="text-xs text-[var(--fg-tertiary)]">
                {count > 0
                  ? `Rigel detected ${count} incident${count === 1 ? "" : "s"} while the app was closed.`
                  : "Rigel is watching your cluster in the background."}
              </p>
            </div>
          </div>
          {count > 0 && (
            <span className="shrink-0 rounded-full bg-[var(--accent-dim)] px-2.5 py-1 text-xs font-semibold text-[var(--accent-primary)]">
              {count} new
            </span>
          )}
        </div>
        {rows > 0 && (
          <div className="flex flex-col gap-2">
            {Array.from({ length: rows }).map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-3 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3.5 py-2.5"
              >
                <span className="size-2 shrink-0 rounded-full bg-[var(--status-pending)]" />
                <span className="h-3 flex-1 rounded bg-white/[0.07]" />
                <span className="shrink-0 text-xs text-[var(--fg-tertiary)]">Degraded</span>
                <span className="shrink-0 rounded bg-[var(--surface-elevated)] px-2 py-0.5 font-mono text-3xs font-semibold text-[var(--fg-tertiary)]">
                  LOW
                </span>
                <Lock className="size-3.5 shrink-0 text-[var(--fg-tertiary)]" />
              </div>
            ))}
          </div>
        )}
        <div className="h-px w-full bg-[var(--border-subtle)]" />
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="font-heading text-sm font-semibold text-[var(--fg-primary)]">Unlock the in-cluster agent</p>
            <p className="text-xs text-[var(--fg-secondary)]">
              See what broke and why, get notified, and let Rigel apply the fixes you approve.
            </p>
          </div>
          <Button size="sm" className="shrink-0" onClick={openUpgrade}>
            <Zap className="size-3.5" />
            Upgrade to Pro
          </Button>
        </div>
      </div>
    </div>
  );
}
