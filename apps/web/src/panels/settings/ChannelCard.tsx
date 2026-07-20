// Shared chrome for the Settings → Channels cards (Signal, Matrix, Discord,
// Slack). One card container + one header (icon tile + title + status dot/label
// + a right-aligned action slot) so every channel renders an identical head and
// can't drift apart. Each section supplies its own body below the header.
import type { ReactNode } from "react";
import { Loader } from "@/components/Loader";

export function ChannelCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 rounded-[14px] border border-[var(--border-subtle)] bg-card p-[18px]">
      {children}
    </div>
  );
}

export function ChannelCardHeader({
  icon,
  iconBg = "var(--accent-dim)",
  iconColor,
  title,
  dotColor,
  statusLabel,
  statusDestructive = false,
  busy = false,
  action,
}: {
  /** Inner icon node (FontAwesome or a brand glyph). The tile sizes it. */
  icon: ReactNode;
  iconBg?: string;
  /** Tile foreground, for glyphs that render with currentColor. */
  iconColor?: string;
  title: string;
  /** Resolved CSS color for the status dot. */
  dotColor: string;
  statusLabel: string;
  statusDestructive?: boolean;
  busy?: boolean;
  /** Right-aligned action(s): the primary button, or a toggle + disconnect group. */
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <div
          className="flex size-9 items-center justify-center rounded-lg"
          style={{ background: iconBg, ...(iconColor ? { color: iconColor } : {}) }}
        >
          {icon}
        </div>
        <div className="flex flex-col gap-[3px]">
          <span className="text-sm font-semibold text-foreground">{title}</span>
          <div className="flex items-center gap-[7px]">
            <span className="inline-block size-1.5 rounded-full" style={{ background: dotColor }} />
            <span className={`text-xs ${statusDestructive ? "text-destructive" : "text-muted-foreground"}`}>
              {statusLabel}
            </span>
            {busy && <Loader size={12} className="text-muted-foreground" />}
          </div>
        </div>
      </div>
      {action}
    </div>
  );
}
