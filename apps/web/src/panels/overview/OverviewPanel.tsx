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
import { PurgePickerSheet } from "@/panels/purge/PurgePickerSheet";
import { PurgeSheet } from "@/panels/purge/PurgeSheet";
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
  formatCpu,
  formatBytes,
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
  const hasMetrics = nodeMetricsData?.available === true && Object.keys(nodeMetrics).length > 0;

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
            {isLoading && (
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-label="loading" />
            )}
            {namespaceFilter && <span className="ov-ns-chip">{namespaceFilter}</span>}
          </div>
          <span className="ov-subtitle">Health at a glance</span>
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

        {/* Row 1 — Gauges */}
        <div className="ov-row ov-row-3">
          <GaugeCard
            icon={Cpu}
            title="Cluster CPU"
            color="#60A5FA"
            fraction={hasMetrics ? totals.cpuFraction : null}
            detail={`${formatCpu(totals.cpuUsed)} / ${formatCpu(totals.cpuAllocatable)}`}
            emptyText="metrics-server unavailable — install it to see live CPU usage."
          />
          <GaugeCard
            icon={MemoryStick}
            title="Cluster Memory"
            color="#A855F7"
            fraction={hasMetrics ? totals.memFraction : null}
            detail={`${formatBytes(String(totals.memUsed))} / ${formatBytes(String(totals.memAllocatable))}`}
            emptyText="metrics-server unavailable — install it to see live memory usage."
          />
          {/* Reclaimable: right-sizing data is not wired to the web store yet. */}
          <GaugeCard
            icon={Recycle}
            title="Reclaimable"
            color="#10B981"
            fraction={null}
            detail=""
            emptyText="no data yet — see the Right-Sizing panel for reclaimable memory."
          />
        </div>

        {/* Row 2 — Stats: Deployments | Pods | Nodes */}
        <div className="ov-row ov-row-3">
          <StatCard
            icon={Layers}
            title="Deployments"
            value={deployments.length}
            caption={plural(deployments.length, "deployment")}
          >
            <HealthLine label="Unhealthy" count={deployUnhealthy} tone="red" neutralWhenZero />
          </StatCard>

          <StatCard icon={Box} title="Pods" value={pods.length} caption={plural(pods.length, "pod")}>
            <HealthLine label="Running" count={phases.running} tone="green" />
            <HealthLine label="Pending" count={phases.pending} tone="yellow" />
            <HealthLine label="Failed" count={phases.failed} tone="red" />
          </StatCard>

          <StatCard
            icon={Server}
            title="Nodes"
            value={`${nodeReady.ready}/${nodeReady.total}`}
            caption="ready"
          >
            <HealthLine label="Pressure conditions" count={pressure} tone="yellow" neutralWhenZero />
          </StatCard>
        </div>

        {/* Row 3 — Databases | Events */}
        <div className="ov-row ov-row-2">
          <SummaryCard
            icon={Database}
            title="Databases"
            value={databases.length}
            unit={plural(databases.length, "instance")}
            statLabel="Unhealthy"
            statCount={dbUnhealthy}
            statTone={dbUnhealthy > 0 ? "red" : "neutral"}
          />
          <SummaryCard
            icon={CalendarClock}
            title="Events"
            value={warnings.length}
            unit="warnings (last 500)"
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
            <AlertTriangle className="ov-card-hdr-icon" style={{ color: "#EF4444" }} />
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

/** Card header: tertiary icon + uppercase mono tracked label. */
function CardHeader({ icon: Icon, title }: { icon: LucideIcon; title: string }) {
  return (
    <div className="ov-card-hdr">
      <Icon className="ov-card-hdr-icon" />
      <span className="ov-card-hdr-label">{title}</span>
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
              <circle cx="54" cy="54" r={RADIUS} fill="none" stroke="#2A2A2A" strokeWidth="14" />
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

/** Stat card: large mono number + caption, then a block of status lines. */
function StatCard({
  icon,
  title,
  value,
  caption,
  children,
}: {
  icon: LucideIcon;
  title: string;
  value: number | string;
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <div className="ov-card">
      <CardHeader icon={icon} title={title} />
      <div className="ov-stat-content">
        <div className="ov-stat-number">
          <span className="ov-stat-big">{value}</span>
          <span className="ov-stat-word">{caption}</span>
        </div>
        <div className="ov-stat-block">{children}</div>
      </div>
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

/** A label + count chip line. `neutralWhenZero` greys the chip when the count is 0. */
function HealthLine({
  label,
  count,
  tone,
  neutralWhenZero,
}: {
  label: string;
  count: number;
  tone: Tone;
  neutralWhenZero?: boolean;
}) {
  const chipTone = neutralWhenZero && count === 0 ? "neutral" : tone;
  return (
    <div className="ov-statusline">
      <span className="ov-statusline-lbl">{label}</span>
      <span className={cn("ov-chip", TONE_CLASS[chipTone])}>{count}</span>
    </div>
  );
}

/** Summary card (Databases / Events): big bold number + unit, divider, one stat line. */
function SummaryCard({
  icon,
  title,
  value,
  unit,
  statLabel,
  statCount,
  statTone,
}: {
  icon: LucideIcon;
  title: string;
  value: number | string;
  unit: string;
  statLabel: string;
  statCount: number;
  statTone: Tone;
}) {
  return (
    <div className="ov-card">
      <CardHeader icon={icon} title={title} />
      <div className="ov-sum-big">
        <span className="ov-sum-n">{value}</span>
        <span className="ov-sum-u">{unit}</span>
      </div>
      <div className="ov-divider" />
      <div className="ov-statusline">
        <span className="ov-statusline-lbl">{statLabel}</span>
        <span
          className={cn("ov-chip", statTone === "neutral" ? "ov-chip-soft" : TONE_CLASS[statTone])}
        >
          {statCount}
        </span>
      </div>
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
                <div style={{ height: `${normPct}%`, background: "#10B981" }} />
                <div style={{ height: `${warnPct}%`, background: "#EF4444" }} />
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
