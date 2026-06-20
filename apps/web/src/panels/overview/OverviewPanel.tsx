import { useEffect, useMemo, useState } from "react";
import {
  LoaderCircle,
  Cpu,
  MemoryStick,
  Recycle,
  Layers,
  Box,
  Server,
  Database,
  CalendarClock,
  Activity,
  AlertTriangle,
  Trash2,
  Sparkles,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { cn } from "@/lib/utils";
import { useNodeMetrics } from "@/lib/api";
import { InfoTooltip } from "@/components/InfoTooltip";
import { PurgePickerSheet } from "@/panels/purge/PurgePickerSheet";
import { PurgeSheet } from "@/panels/purge/PurgeSheet";
import { useRightSizing } from "@/panels/rightsizing/useRightSizing";
import type {
  Deployment,
  EventBucket,
  K8sEvent,
  Node,
  NodeMetrics,
  Pod,
} from "./types";
import {
  phaseCounts,
  unhealthyDeploymentCount,
  nodeReadyCount,
  nodePressureCount,
  clusterResourceTotals,
  perNodeResourceTotals,
  formatCpu,
  formatBytes,
  type NodeResourceTotals,
} from "./overviewDisplay";
import {
  sortEvents,
  isWarning,
  eventBuckets,
  relativeAge,
  absoluteWhen,
  when,
} from "@/panels/events/eventsDisplay";
import { buildInstances } from "@/panels/databases/databasesDisplay";
import type {
  CNPGCluster,
  CNPGScheduledBackup,
  WorkloadDB,
} from "@/panels/databases/types";

// ---------------------------------------------------------------------------
// NOTE (docs/parity/overview.md). This is primarily a READ-ONLY landing dashboard
// except for two entry points:
//   - "Purge an app…" (docs/parity/purge.md): picker → typed-name confirm sheet.
//   - "Investigate cluster": injects a health-check prompt into the always-visible
//     ChatPane via the onInvestigateCluster prop (connected in App.tsx).
// The following remain deferred and must NOT be added without a new feature spec:
//   - Event timeline drilldown — the ribbon is display-only here.
//   - Namespace-scoped aggregation — Overview is always cluster-wide.
// ---------------------------------------------------------------------------

const TIMELINE_SPAN_SECONDS = 3600;
const TIMELINE_BUCKETS = 60;
const MAX_RECENT_WARNINGS = 10;

interface OverviewPanelProps {
  /** Called when the user clicks "Investigate cluster" — injects the prompt into the chat pane. */
  onInvestigateCluster?: () => void;
}

export default function OverviewPanel({ onInvestigateCluster }: OverviewPanelProps) {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);

  // Purge flow: picker → typed-name confirm sheet.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState<{ name: string; namespace: string } | null>(null);

  // Subscribe to the five cluster-wide watches on mount; unsubscribe on unmount.
  // All cluster-scoped: namespace "*" (Overview never applies the namespace
  // filter — aggregates are always cluster-wide).
  useEffect(() => {
    const kinds = [
      "nodes",
      "pods",
      "deployments",
      "statefulsets",
      "events",
      "namespaces",
      "clusters.postgresql.cnpg.io",
      "scheduledbackups.postgresql.cnpg.io",
    ];
    for (const k of kinds) subscribe(k, "*");
    return () => {
      for (const k of kinds) unsubscribe(k, "*");
    };
  }, []);

  const nodes = useMemo(
    () => Object.values((resources["nodes"] ?? {}) as Record<string, Node>),
    [resources],
  );
  const pods = useMemo(
    () => Object.values((resources["pods"] ?? {}) as Record<string, Pod>),
    [resources],
  );
  const deployments = useMemo(
    () => Object.values((resources["deployments"] ?? {}) as Record<string, Deployment>),
    [resources],
  );
  const events = useMemo(
    () => sortEvents(Object.values((resources["events"] ?? {}) as Record<string, K8sEvent>)),
    [resources],
  );
  // Fetch live node metrics from the metrics-server REST API.
  const { data: nodeMetricsData } = useNodeMetrics();

  // Build a nodeMetrics map keyed by node name, matching overviewDisplay expectations.
  const nodeMetrics = useMemo<Record<string, NodeMetrics>>(() => {
    if (!nodeMetricsData?.available || !nodeMetricsData.items) return {};
    const map: Record<string, NodeMetrics> = {};
    for (const item of nodeMetricsData.items) {
      map[item.name] = {
        metadata: { name: item.name },
        usage: {
          // The metrics endpoint returns cpu as plain millicores ("1080") but
          // memory already unit-suffixed ("10393Mi") — only add a unit when one
          // isn't already present (avoids "10393MiMi" → 0).
          cpu: /[a-z]/i.test(String(item.cpu)) ? String(item.cpu) : `${item.cpu}m`,
          memory: /[a-z]/i.test(String(item.memory)) ? String(item.memory) : `${item.memory}Mi`,
        },
      };
    }
    return map;
  }, [nodeMetricsData]);

  // --- Derived card data ---------------------------------------------------
  const totals = useMemo(() => clusterResourceTotals(nodes, nodeMetrics), [nodes, nodeMetrics]);
  const perNode = useMemo(() => perNodeResourceTotals(nodes, nodeMetrics), [nodes, nodeMetrics]);
  const hasMetrics = nodeMetricsData?.available === true && Object.keys(nodeMetrics).length > 0;

  // Reclaimable memory — same right-sizing pipeline the Right-Sizing panel uses,
  // summed across the current namespace scope.
  const { workloads: rsWorkloads, usingBackend: rsBackend } = useRightSizing();
  const reclaimBytes = useMemo(
    () => rsWorkloads.reduce((sum, w) => sum + Math.max(0, w.reclaimableMemBytes), 0),
    [rsWorkloads],
  );

  const deployUnhealthy = unhealthyDeploymentCount(deployments);
  const phases = useMemo(() => phaseCounts(pods), [pods]);
  const nodeReady = nodeReadyCount(nodes);
  const pressure = nodePressureCount(nodes);

  // Detected databases — CNPG clusters + image-detected workloads (same logic
  // as the Databases panel), so the count matches instead of a 0 stub.
  const databases = useMemo(
    () =>
      buildInstances({
        cnpgClusters: Object.values(
          (resources["clusters.postgresql.cnpg.io"] ?? {}) as Record<string, CNPGCluster>,
        ),
        scheduledBackups: Object.values(
          (resources["scheduledbackups.postgresql.cnpg.io"] ?? {}) as Record<
            string,
            CNPGScheduledBackup
          >,
        ),
        deployments: deployments as unknown as WorkloadDB[],
        statefulSets: Object.values(
          (resources["statefulsets"] ?? {}) as Record<string, WorkloadDB>,
        ),
      }),
    [resources, deployments],
  );
  const dbUnhealthy = databases.filter((d) => !d.isHealthy).length;

  const warnings = useMemo(() => events.filter(isWarning), [events]);
  const recentWarnings = warnings.slice(0, MAX_RECENT_WARNINGS);

  const buckets = useMemo(
    () => eventBuckets(events, Date.now(), TIMELINE_SPAN_SECONDS, TIMELINE_BUCKETS),
    [events],
  );

  return (
    <div className="ov-root">
      {/* Top bar — full-bleed header (Pencil "Top bar") */}
      <div className="ov-topbar">
        <div className="ov-title-col">
          <div className="ov-title-row">
            <h1 className="ov-title">Overview</h1>
            <InfoTooltip label="Health at a glance" />
            {isLoading && (
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-label="loading" />
            )}
            {namespaceFilter && <span className="ov-ns-chip">{namespaceFilter}</span>}
          </div>
        </div>

        <div className="ov-actions">
          <button className="ov-btn-purge" onClick={() => setPickerOpen(true)}>
            <Trash2 className="ov-btn-icon" />
            Purge an app
          </button>
          <button className="ov-btn-investigate" onClick={onInvestigateCluster}>
            <Sparkles className="ov-btn-icon" />
            Investigate cluster
          </button>
        </div>
      </div>

      {/* Scroll area */}
      <div className="ov-content">
        {error && <pre className="ov-error">{error}</pre>}

        {/* Row 1 — Per-node CPU/memory utilization + reclaimable */}
        <div className="ov-row ov-row-3">
          <NodeGaugesCard
            icon={Cpu}
            title="CPU per node"
            color="#60A5FA"
            nodes={perNode}
            metric="cpu"
            show={hasMetrics}
            emptyText="metrics-server unavailable — install it to see live CPU usage."
          />
          <NodeGaugesCard
            icon={MemoryStick}
            title="Memory per node"
            color="#38BDF8"
            nodes={perNode}
            metric="memory"
            show={hasMetrics}
            emptyText="metrics-server unavailable — install it to see live memory usage."
          />
          {/* Reclaimable memory from the right-sizing pipeline (shared hook). */}
          <GaugeCard
            icon={Recycle}
            title="Reclaimable"
            color="#10B981"
            fraction={rsBackend && totals.memAllocatable > 0 ? Math.min(1, reclaimBytes / totals.memAllocatable) : null}
            detail={rsBackend ? `${formatBytes(String(reclaimBytes))} of ${formatBytes(String(totals.memAllocatable))}` : ""}
            emptyText="connect a metrics backend in Right-Sizing to see reclaimable memory."
          />
        </div>

        {/* Row 2 — Stats: Deployments | Pods | Nodes */}
        <div className="ov-row ov-row-3">
          <StatCard
            icon={Layers}
            title="Deployments"
            value={deployments.length}
            chips={[{ label: "Unhealthy", count: deployUnhealthy, tone: "red", neutralWhenZero: true }]}
          />

          <StatCard
            icon={Box}
            title="Pods"
            value={pods.length}
            chips={[
              { label: "Running", count: phases.running, tone: "green" },
              { label: "Pending", count: phases.pending, tone: "yellow" },
              { label: "Failed", count: phases.failed, tone: "red" },
            ]}
          />

          <StatCard
            icon={Server}
            title="Nodes"
            value={`${nodeReady.ready}/${nodeReady.total}`}
            chips={[{ label: "Pressure conditions", count: pressure, tone: "yellow", neutralWhenZero: true }]}
          />
        </div>

        {/* Row 3 — Databases | Events */}
        <div className="ov-row ov-row-2">
          <SummaryCard
            icon={Database}
            title="Databases"
            value={databases.length}
            statLabel="Unhealthy"
            statCount={dbUnhealthy}
            statTone={dbUnhealthy > 0 ? "red" : "neutral"}
          />
          <SummaryCard
            icon={CalendarClock}
            title="Events"
            value={warnings.length}
            statLabel="Total cached"
            statCount={events.length}
            statTone="neutral"
          />
        </div>

        {/* Event activity — 1h span, 60 stacked warning/normal buckets, display-only */}
        <EventActivityCard buckets={buckets} />

        {/* Recent warnings — up to 10, newest first */}
        <div className="ov-card">
          <div className="ov-card-hdr">
            <AlertTriangle className="ov-card-hdr-icon" style={{ color: "var(--status-failed)" }} />
            <span className="ov-card-hdr-label">Recent warnings</span>
          </div>
          {recentWarnings.length === 0 ? (
            <p className="ov-warn-empty">No warning events.</p>
          ) : (
            <>
              <div className="ov-warn-list">
                {recentWarnings.map((e) => (
                  <WarningRow key={e.metadata.uid} event={e} />
                ))}
              </div>
              <span className="ov-warn-foot">
                Showing {recentWarnings.length} of {warnings.length}{" "}
                {plural(warnings.length, "warning")}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Purge flow: pick → discover → typed-name confirm → execute. */}
      <PurgePickerSheet
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(target) => setPurgeTarget(target)}
      />
      <PurgeSheet
        target={purgeTarget}
        open={purgeTarget !== null}
        onClose={() => setPurgeTarget(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Presentational sub-components
// ---------------------------------------------------------------------------

/** Card header: tertiary icon + uppercase mono tracked label, with an optional
 *  right-aligned slot (used for status chips on the stat/summary cards). */
function CardHeader({ icon: Icon, title, right }: { icon: LucideIcon; title: string; right?: React.ReactNode }) {
  return (
    <div className="ov-card-hdr">
      <div className="ov-card-hdr-left">
        <Icon className="ov-card-hdr-icon" />
        <span className="ov-card-hdr-label">{title}</span>
      </div>
      {right && <div className="ov-card-hdr-right">{right}</div>}
    </div>
  );
}

/** Ring gauge card (108px donut). `fraction === null` renders the empty state. */
function GaugeCard({
  icon,
  title,
  fraction,
  color,
  detail,
  emptyText,
}: {
  icon: LucideIcon;
  title: string;
  fraction: number | null;
  color: string;
  detail: string;
  emptyText: string;
}) {
  const RADIUS = 47;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

  return (
    <div className="ov-card">
      <CardHeader icon={icon} title={title} />
      {fraction === null ? (
        <div className="ov-gauge-empty">
          <div className="ov-gauge-dash" />
          <span className="ov-gauge-empty-text">{emptyText}</span>
        </div>
      ) : (
        <div className="ov-gauge-body">
          <div className="ov-gauge">
            <svg width="108" height="108" viewBox="0 0 108 108" style={{ display: "block" }}>
              <circle cx="54" cy="54" r={RADIUS} fill="none" stroke="#34353A" strokeWidth="14" />
              <circle
                cx="54"
                cy="54"
                r={RADIUS}
                fill="none"
                stroke={color}
                strokeWidth="14"
                strokeLinecap="round"
                strokeDasharray={`${CIRCUMFERENCE * clamp01(fraction)} ${CIRCUMFERENCE}`}
                transform="rotate(-90 54 54)"
                style={{ transition: "stroke-dasharray 0.4s ease" }}
              />
            </svg>
            <div className="ov-gauge-pct">{Math.round(clamp01(fraction) * 100)}%</div>
          </div>
          <span className="ov-gauge-raw">{detail}</span>
        </div>
      )}
    </div>
  );
}

/** A card of per-node ring gauges for one metric (CPU or memory). */
function NodeGaugesCard({
  icon,
  title,
  color,
  nodes,
  metric,
  show,
  emptyText,
}: {
  icon: LucideIcon;
  title: string;
  color: string;
  nodes: NodeResourceTotals[];
  metric: "cpu" | "memory";
  show: boolean;
  emptyText: string;
}) {
  return (
    <div className="ov-card">
      <CardHeader icon={icon} title={title} />
      {!show || nodes.length === 0 ? (
        <div className="ov-gauge-empty">
          <div className="ov-gauge-dash" />
          <span className="ov-gauge-empty-text">{emptyText}</span>
        </div>
      ) : (
        <div className="ov-nodegrid">
          {nodes.map((n) => (
            <NodeGauge
              key={n.name}
              name={n.name}
              color={color}
              fraction={metric === "cpu" ? n.cpuFraction : n.memFraction}
              detail={
                metric === "cpu"
                  ? `${formatCpu(n.cpuUsed)}/${formatCpu(n.cpuAllocatable)}`
                  : `${formatBytes(String(n.memUsed))}/${formatBytes(String(n.memAllocatable))}`
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** One node ring (104px) with % in the center and a name + used/alloc below. */
function NodeGauge({ name, fraction, color, detail }: { name: string; fraction: number; color: string; detail: string }) {
  const R = 44;
  const C = 2 * Math.PI * R;
  return (
    <div className="ov-node-gauge">
      <div className="ov-node-ring">
        <svg width="100%" height="100%" viewBox="0 0 104 104" style={{ display: "block" }}>
          <circle cx="52" cy="52" r={R} fill="none" stroke="#34353A" strokeWidth="12" />
          <circle
            cx="52"
            cy="52"
            r={R}
            fill="none"
            stroke={color}
            strokeWidth="12"
            strokeLinecap="round"
            strokeDasharray={`${C * clamp01(fraction)} ${C}`}
            transform="rotate(-90 52 52)"
            style={{ transition: "stroke-dasharray 0.4s ease" }}
          />
        </svg>
        <div className="ov-node-pct">{Math.round(clamp01(fraction) * 100)}%</div>
      </div>
      <span className="ov-node-name" title={name}>{name}</span>
      <span className="ov-node-detail">{detail}</span>
    </div>
  );
}

type Tone = "green" | "yellow" | "red" | "neutral";

const TONE_CLASS: Record<Tone, string> = {
  green: "ov-chip-green",
  yellow: "ov-chip-yellow",
  red: "ov-chip-red",
  neutral: "ov-chip-neutral",
};

/** A bare count chip. `label` is the hover tooltip; `neutralWhenZero` greys it
 *  when the count is 0. */
type ChipSpec = { label: string; count: number; tone: Tone; neutralWhenZero?: boolean };

/** A row of label-less count chips (used in card headers); the label shows on hover. */
function ChipRow({ chips }: { chips: ChipSpec[] }) {
  return (
    <>
      {chips.map((c, i) => {
        const tone = c.neutralWhenZero && c.count === 0 ? "neutral" : c.tone;
        return (
          <span key={i} className={cn("ov-chip", TONE_CLASS[tone])} title={c.label} aria-label={`${c.label}: ${c.count}`}>
            {c.count}
          </span>
        );
      })}
    </>
  );
}

/** Stat card: status chips on the title line + a large mono number. */
function StatCard({
  icon,
  title,
  value,
  chips,
}: {
  icon: LucideIcon;
  title: string;
  value: number | string;
  chips: ChipSpec[];
}) {
  return (
    <div className="ov-card">
      <CardHeader icon={icon} title={title} right={<ChipRow chips={chips} />} />
      <div className="ov-stat-big">{value}</div>
    </div>
  );
}

/** Summary card (Databases / Events): a status chip on the title line + a big number. */
function SummaryCard({
  icon,
  title,
  value,
  statLabel,
  statCount,
  statTone,
}: {
  icon: LucideIcon;
  title: string;
  value: number | string;
  statLabel: string;
  statCount: number;
  statTone: Tone;
}) {
  return (
    <div className="ov-card">
      <CardHeader
        icon={icon}
        title={title}
        right={
          <span
            className={cn("ov-chip", statTone === "neutral" ? "ov-chip-soft" : TONE_CLASS[statTone])}
            title={statLabel}
            aria-label={`${statLabel}: ${statCount}`}
          >
            {statCount}
          </span>
        }
      />
      <div className="ov-sum-n">{value}</div>
    </div>
  );
}

/** Event-activity card: stacked warning(red)/normal(green) histogram over the 1h window. */
function EventActivityCard({ buckets }: { buckets: EventBucket[] }) {
  const hasActivity = buckets.some((b) => b.warnings + b.normal > 0);
  const max = Math.max(1, ...buckets.map((b) => b.warnings + b.normal));
  return (
    <div className="ov-card">
      <CardHeader icon={Activity} title="Event activity — last 1h" />
      {hasActivity ? (
        <div className="ov-chart">
          {buckets.map((b) => {
            const total = b.warnings + b.normal;
            const warnPct = (b.warnings / max) * 100;
            const normPct = (b.normal / max) * 100;
            return (
              <div
                key={b.index}
                className="ov-bar-col"
                title={total > 0 ? `${b.warnings} warning, ${b.normal} normal` : undefined}
              >
                <div style={{ height: `${normPct}%`, background: "var(--status-running)" }} />
                <div style={{ height: `${warnPct}%`, background: "var(--status-failed)" }} />
              </div>
            );
          })}
        </div>
      ) : (
        <div className="ov-chart-empty">No event activity in the last hour</div>
      )}
    </div>
  );
}

/** One recent-warning row: red left bar | reason | resource | message | age. */
function WarningRow({ event }: { event: K8sEvent }) {
  const ts = when(event);
  const age = relativeAge(ts);
  const tooltip = absoluteWhen(ts) ?? undefined;
  return (
    <div className="ov-warn-row">
      <span className="ov-warn-reason">{event.reason ?? "—"}</span>
      <span className="ov-warn-res" title={targetLabel(event)}>
        {targetLabel(event)}
      </span>
      <span className="ov-warn-msg">{event.message ?? "—"}</span>
      <span className="ov-warn-time" title={tooltip}>
        {age}
      </span>
    </div>
  );
}

/** Clamp a fraction to [0, 1]. */
function clamp01(n: number): number {
  return Math.min(Math.max(n, 0), 1);
}

/** "kind/name" or "kind/name · namespace"; "—" if no name. */
function targetLabel(event: K8sEvent): string {
  const io = event.involvedObject;
  const name = io?.name ?? "";
  if (name === "") return "—";
  const kind = io?.kind ?? "";
  const base = kind ? `${kind}/${name}` : name;
  const ns = io?.namespace;
  return ns ? `${base} · ${ns}` : base;
}

/** Pluralize a noun by count: 1 → "1 deployment", else "N deployments". */
function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}
