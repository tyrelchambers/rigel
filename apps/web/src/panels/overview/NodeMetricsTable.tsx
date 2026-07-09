import { Recycle } from "lucide-react";
import { cn } from "@/lib/utils";
import { MetricsServerEmptyState } from "./MetricsServerEmptyState";
import { formatCpu, formatBytes, type NodeResourceTotals } from "./overviewDisplay";

const WARN_PERCENT = 80;

// Shared 3-column grid for the head row and each data row. Tracks use minmax(0,…)
// so the metric columns can shrink below their content instead of overflowing the
// (overflow-hidden) table shell; container variants narrow it on the panel's width.
const COLS =
  "grid grid-cols-[minmax(120px,180px)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-6 @max-[760px]:gap-3.5 @max-[620px]:grid-cols-[minmax(90px,140px)_minmax(0,1fr)_minmax(0,1fr)]";

export interface ReclaimableSummary {
  fraction: number;
  detail: string;
}

interface NodeMetricsTableProps {
  rows: NodeResourceTotals[];
  readyByName: Record<string, boolean>;
  hasMetrics: boolean;
  reclaimable: ReclaimableSummary | null;
}

function clamp01(n: number): number {
  return Math.min(Math.max(n, 0), 1);
}
function pct(fraction: number): string {
  return `${Math.round(clamp01(fraction) * 100)}%`;
}

function MetricCell({ fraction, raw }: { fraction: number; raw: string }) {
  // Round once so the bar width, label, and warn color all agree at the boundary
  // (a row reading "80%" is always amber, never split blue/amber).
  const percent = Math.round(clamp01(fraction) * 100);
  const warn = percent >= WARN_PERCENT;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--surface-sunken)]">
        <div
          data-warn={warn}
          className={cn(
            "h-2 rounded-full transition-[width] duration-[400ms]",
            warn ? "bg-[var(--status-pending)]" : "bg-[var(--accent-primary)]",
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-xs font-semibold text-[var(--fg-primary)]">{percent}%</span>
        <span className="min-w-0 truncate font-mono text-2xs text-[var(--fg-tertiary)]" title={raw}>{raw}</span>
      </div>
    </div>
  );
}

/** Layout C — dense per-node CPU/memory table with a reclaimable header badge. */
export function NodeMetricsTable({ rows, readyByName, hasMetrics, reclaimable }: NodeMetricsTableProps) {
  return (
    <section className="flex flex-col gap-3.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-[18px]">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-[var(--fg-primary)]">Node overview</h2>
        {reclaimable && (
          <div
            className="flex items-center gap-[9px] rounded-full border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-[13px] py-1.5"
            title="Reclaimable memory (from right-sizing)"
          >
            <Recycle className="size-[13px] shrink-0 text-[var(--status-running)]" />
            <span className="text-xs text-[var(--fg-secondary)]">Reclaimable</span>
            <span className="font-mono text-xs font-semibold text-[var(--status-running)]">{pct(reclaimable.fraction)}</span>
            <span className="font-mono text-2xs text-[var(--fg-tertiary)]">{reclaimable.detail}</span>
          </div>
        )}
      </div>

      {hasMetrics && rows.length > 0 ? (
        <div className="flex flex-col overflow-hidden rounded-lg border border-[var(--border-subtle)]">
          <div className={cn(COLS, "border-b border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-4 py-2.5")}>
            <span className="font-mono text-2xs tracking-[1px] text-[var(--fg-tertiary)]">NODE</span>
            <span className="font-mono text-2xs tracking-[1px] text-[var(--fg-tertiary)]">
              CPU <span className="font-normal normal-case tracking-normal opacity-80">(used / allocatable)</span>
            </span>
            <span className="font-mono text-2xs tracking-[1px] text-[var(--fg-tertiary)]">
              MEMORY <span className="font-normal normal-case tracking-normal opacity-80">(used / allocatable)</span>
            </span>
          </div>
          {rows.map((n) => (
            <div className={cn(COLS, "border-b border-[var(--border-subtle)] px-4 py-3 last:border-b-0")} key={n.name}>
              <div className="flex min-w-0 items-center gap-[9px]">
                <span
                  role="img"
                  aria-label={readyByName[n.name] ? "Ready" : "Not Ready"}
                  title={readyByName[n.name] ? "Ready" : "Not Ready"}
                  className={cn(
                    "size-[7px] shrink-0 rounded-full",
                    readyByName[n.name] ? "bg-[var(--status-running)]" : "bg-[var(--status-failed)]",
                  )}
                />
                <span className="truncate text-xs font-medium text-[var(--fg-primary)]" title={n.name}>
                  {n.name}
                </span>
              </div>
              <MetricCell fraction={n.cpuFraction} raw={`${formatCpu(n.cpuUsed)}/${formatCpu(n.cpuAllocatable)}`} />
              <MetricCell fraction={n.memFraction} raw={`${formatBytes(String(n.memUsed))}/${formatBytes(String(n.memAllocatable))}`} />
            </div>
          ))}
        </div>
      ) : (
        <MetricsServerEmptyState />
      )}
    </section>
  );
}
