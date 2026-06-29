import { Recycle } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCpu, formatBytes, type NodeResourceTotals } from "./overviewDisplay";

const WARN_PERCENT = 80;

// Shared 3-column grid for the head row and each data row (narrows on small widths).
const COLS =
  "grid grid-cols-[180px_1fr_1fr] items-center gap-6 max-[1100px]:grid-cols-[140px_1fr_1fr] max-[1100px]:gap-3.5";

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
    <div className="flex min-w-0 items-center gap-3">
      <div className="h-2 max-w-[200px] flex-1 overflow-hidden rounded-full bg-[var(--surface-sunken)]">
        <div
          data-warn={warn}
          className={cn(
            "h-2 rounded-full transition-[width] duration-[400ms]",
            warn ? "bg-[var(--status-pending)]" : "bg-[var(--accent-primary)]",
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="shrink-0 font-mono text-[13px] font-semibold text-[var(--fg-primary)]">{percent}%</span>
      <span className="shrink-0 font-mono text-[11px] text-[var(--fg-tertiary)]">{raw}</span>
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
            <span className="font-mono text-[11px] text-[var(--fg-tertiary)]">{reclaimable.detail}</span>
          </div>
        )}
      </div>

      {hasMetrics && rows.length > 0 ? (
        <div className="flex flex-col overflow-hidden rounded-lg border border-[var(--border-subtle)]">
          <div className={cn(COLS, "border-b border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-4 py-2.5")}>
            <span className="font-mono text-[11px] tracking-[1px] text-[var(--fg-tertiary)]">NODE</span>
            <span className="font-mono text-[11px] tracking-[1px] text-[var(--fg-tertiary)]">
              CPU <span className="font-normal normal-case tracking-normal opacity-80">(used / allocatable)</span>
            </span>
            <span className="font-mono text-[11px] tracking-[1px] text-[var(--fg-tertiary)]">
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
                <span className="truncate text-[13px] font-medium text-[var(--fg-primary)]" title={n.name}>
                  {n.name}
                </span>
              </div>
              <MetricCell fraction={n.cpuFraction} raw={`${formatCpu(n.cpuUsed)}/${formatCpu(n.cpuAllocatable)}`} />
              <MetricCell fraction={n.memFraction} raw={`${formatBytes(String(n.memUsed))}/${formatBytes(String(n.memAllocatable))}`} />
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center gap-3.5 px-[18px] py-8 text-center">
          <div className="h-0.5 w-7 rounded-[1px] bg-[var(--border-strong)]" />
          <span className="text-xs leading-relaxed text-[var(--fg-tertiary)]">
            metrics-server unavailable — install it to see live node usage.
          </span>
        </div>
      )}
    </section>
  );
}
