import { Recycle } from "lucide-react";
import { formatCpu, formatBytes, type NodeResourceTotals } from "./overviewDisplay";

const WARN_THRESHOLD = 0.8;

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
  const f = clamp01(fraction);
  return (
    <div className="ov-mtable-cell">
      <div className="ov-mtable-track">
        <div
          className={"ov-mtable-fill" + (f >= WARN_THRESHOLD ? " ov-mtable-fill--warn" : "")}
          style={{ width: `${f * 100}%` }}
        />
      </div>
      <span className="ov-mtable-pct">{pct(f)}</span>
      <span className="ov-mtable-raw">{raw}</span>
    </div>
  );
}

/** Layout C — dense per-node CPU/memory table with a reclaimable header badge. */
export function NodeMetricsTable({ rows, readyByName, hasMetrics, reclaimable }: NodeMetricsTableProps) {
  return (
    <section className="ov-card ov-mtable">
      {reclaimable && (
        <div className="ov-mtable-hdr">
          <div className="ov-mtable-reclaim" title="Reclaimable memory (from right-sizing)">
            <Recycle className="ov-mtable-reclaim-icon" />
            <span className="ov-mtable-reclaim-label">Reclaimable</span>
            <span className="ov-mtable-reclaim-pct">{pct(reclaimable.fraction)}</span>
            <span className="ov-mtable-reclaim-detail">{reclaimable.detail}</span>
          </div>
        </div>
      )}

      {hasMetrics && rows.length > 0 ? (
        <div className="ov-mtable-grid">
          <div className="ov-mtable-headrow">
            <span className="ov-mtable-h">NODE</span>
            <span className="ov-mtable-h">CPU</span>
            <span className="ov-mtable-h">MEMORY</span>
          </div>
          {rows.map((n) => (
            <div className="ov-mtable-row" key={n.name}>
              <div className="ov-mtable-node">
                <span
                  className="ov-mtable-dot"
                  style={{ background: readyByName[n.name] ? "var(--status-running)" : "var(--status-failed)" }}
                />
                <span className="ov-mtable-name" title={n.name}>{n.name}</span>
              </div>
              <MetricCell fraction={n.cpuFraction} raw={`${formatCpu(n.cpuUsed)}/${formatCpu(n.cpuAllocatable)}`} />
              <MetricCell fraction={n.memFraction} raw={`${formatBytes(String(n.memUsed))}/${formatBytes(String(n.memAllocatable))}`} />
            </div>
          ))}
        </div>
      ) : (
        <div className="ov-gauge-empty">
          <div className="ov-gauge-dash" />
          <span className="ov-gauge-empty-text">metrics-server unavailable — install it to see live node usage.</span>
        </div>
      )}
    </section>
  );
}
