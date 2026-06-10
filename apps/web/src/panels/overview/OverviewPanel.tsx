import { useEffect, useMemo, useState } from "react";
import {
  LoaderCircle,
  Layers,
  Box,
  Server,
  Database,
  MessageSquareWarning,
  Activity,
  AlertTriangle,
  Gauge,
  Trash2,
  Sparkles,
} from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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
    <div className="h-full space-y-4 overflow-auto">
      {/* Header — mirrors OverviewPanel.swift header */}
      <div className="flex items-center gap-3">
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold">Overview</h1>
            {isLoading && (
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-label="loading" />
            )}
          </div>
          <span className="text-xs text-muted-foreground">Health at a glance</span>
        </div>
        {namespaceFilter && (
          <span
            style={{
              fontFamily: "ui-monospace, monospace",
              fontSize: 11,
              color: "#6B6B73",
              background: "#141417",
              padding: "2px 6px",
              borderRadius: 4,
              border: "1px solid #1A1A1A",
            }}
          >
            {namespaceFilter}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {/* Purge an app — destructive outline */}
          <Button
            variant="outline"
            size="sm"
            className="border-red-600/40 text-red-500 hover:bg-red-600/10 hover:text-red-400"
            onClick={() => setPickerOpen(true)}
          >
            <Trash2 className="size-3.5" />
            Purge an app
          </Button>

          {/* Investigate cluster — purple filled */}
          <Button
            size="sm"
            className="bg-purple-600 hover:bg-purple-500 text-white"
            onClick={onInvestigateCluster}
          >
            <Sparkles className="size-3.5" />
            Investigate cluster
          </Button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <pre className="rounded-md bg-destructive/10 px-3 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
          {error}
        </pre>
      )}

      {/* Gauges row (or metrics-unavailable fallback) */}
      {hasMetrics ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <GaugeCard
            title="Cluster CPU"
            fraction={totals.cpuFraction}
            detail={`${formatCpu(totals.cpuUsed)} / ${formatCpu(totals.cpuAllocatable)}`}
          />
          <GaugeCard
            title="Cluster Memory"
            fraction={totals.memFraction}
            detail={`${formatBytes(String(totals.memUsed))} / ${formatBytes(String(totals.memAllocatable))}`}
          />
          {/* Reclaimable: right-sizing data is not wired to the web store yet. */}
          <Card title="Reclaimable" icon={<Gauge className="size-3.5" />}>
            <div className="font-mono text-2xl">—</div>
            <p className="mt-1 text-xs text-muted-foreground">
              no data yet — see the Right-Sizing panel for reclaimable memory.
            </p>
          </Card>
        </div>
      ) : (
        <Card title="Cluster Usage" icon={<Gauge className="size-3.5" />}>
          <p className="text-sm text-muted-foreground">
            metrics-server unavailable — install it to see live CPU/memory usage.
          </p>
        </Card>
      )}

      {/* Top row: Deployments | Pods | Nodes */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Card title="Deployments" icon={<Layers className="size-3.5" />}>
          <Metric value={deployments.length} caption={plural(deployments.length, "deployment")} />
          <HealthLine label="Unhealthy" count={deployUnhealthy} tone="red" />
        </Card>

        <Card title="Pods" icon={<Box className="size-3.5" />}>
          <Metric value={pods.length} caption={plural(pods.length, "pod")} />
          <HealthLine label="Running" count={phases.running} tone="green" />
          <HealthLine label="Pending" count={phases.pending} tone="yellow" />
          <HealthLine label="Failed" count={phases.failed} tone="red" />
        </Card>

        <Card title="Nodes" icon={<Server className="size-3.5" />}>
          <Metric value={`${nodeReady.ready}/${nodeReady.total}`} caption="ready" />
          <HealthLine label="Pressure conditions" count={pressure} tone="yellow" />
        </Card>
      </div>

      {/* Middle row: Databases | Events */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Card title="Databases" icon={<Database className="size-3.5" />}>
          <Metric value={databases.length} caption={plural(databases.length, "instance")} />
          <HealthLine label="Unhealthy" count={dbUnhealthy} tone="red" />
        </Card>

        <Card title="Events" icon={<MessageSquareWarning className="size-3.5" />}>
          <Metric value={warnings.length} caption="warnings (last 500)" />
          <HealthLine label="Total cached" count={events.length} tone="muted" />
        </Card>
      </div>

      {/* Event timeline — 1h span, 60 stacked warning/normal buckets, display-only */}
      <Card title="Event activity — last 1h" icon={<Activity className="size-3.5" />}>
        <EventTimeline buckets={buckets} />
      </Card>

      {/* Recent warnings — up to 10, newest first */}
      <div className="rounded-lg border p-3">
        <div className="mb-2 flex items-center gap-2 border-b pb-2">
          <AlertTriangle className="size-3.5 text-red-600" />
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Recent warnings
          </span>
        </div>
        {recentWarnings.length === 0 ? (
          <p className="px-1.5 py-2 text-sm text-muted-foreground">No warning events.</p>
        ) : (
          <div className="space-y-px">
            {recentWarnings.map((e) => (
              <WarningRow key={e.metadata.uid} event={e} />
            ))}
          </div>
        )}
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

/** Simple bordered card with an uppercase, tracked, icon-led title. */
function Card({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border p-3.5">
      <div className="mb-2 flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="text-xs font-medium uppercase tracking-wide">{title}</span>
      </div>
      {children}
    </div>
  );
}

/** Big monospace metric value with a small caption. */
function Metric({ value, caption }: { value: number | string; caption: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="font-mono text-2xl font-semibold">{value}</span>
      <span className="text-xs text-muted-foreground">{caption}</span>
    </div>
  );
}

type Tone = "green" | "yellow" | "red" | "muted";

const TONE_CLASS: Record<Tone, string> = {
  green: "text-green-600 bg-green-600/15",
  yellow: "text-yellow-600 bg-yellow-600/15",
  red: "text-red-600 bg-red-600/15",
  muted: "text-muted-foreground bg-muted",
};

/** A label + colored count chip line under a metric. */
function HealthLine({ label, count, tone }: { label: string; count: number; tone: Tone }) {
  return (
    <div className="mt-1.5 flex items-center justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("rounded px-1.5 py-0.5 font-mono font-semibold", TONE_CLASS[tone])}>
        {count}
      </span>
    </div>
  );
}

/** Ring gauge: large centered donut (120px) matching RingGauge.swift. */
function GaugeCard({
  title,
  fraction,
  detail,
}: {
  title: string;
  fraction: number;
  detail: string;
}) {
  const pct = Math.round(Math.min(Math.max(fraction, 0), 1) * 100);
  // SVG donut approach: 120px outer, ~16px track, accent arc
  const RADIUS = 46;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
  const arcLength = CIRCUMFERENCE * Math.min(Math.max(fraction, 0), 1);

  return (
    <Card title={title} icon={<Gauge className="size-3.5" />}>
      <div className="flex flex-col items-center gap-2 py-1">
        {/* Donut ring — 120px */}
        <div style={{ position: "relative", width: 120, height: 120 }}>
          <svg width="120" height="120" viewBox="0 0 120 120" style={{ display: "block" }}>
            {/* Track */}
            <circle
              cx="60" cy="60" r={RADIUS}
              fill="none"
              stroke="#1A1A2E"
              strokeWidth="14"
            />
            {/* Arc */}
            <circle
              cx="60" cy="60" r={RADIUS}
              fill="none"
              stroke="#A855F7"
              strokeWidth="14"
              strokeLinecap="round"
              strokeDasharray={`${arcLength} ${CIRCUMFERENCE}`}
              strokeDashoffset={CIRCUMFERENCE / 4} /* start at top */
              transform="rotate(-90 60 60)"
              style={{ transition: "stroke-dasharray 0.4s ease" }}
            />
          </svg>
          {/* Centered percentage */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span
              style={{
                fontFamily: "ui-monospace, monospace",
                fontSize: 22,
                fontWeight: 700,
                color: "#FFFFFF",
                lineHeight: 1,
              }}
            >
              {pct}%
            </span>
          </div>
        </div>
        {/* Label below ring */}
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: "#6B6B73",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            textAlign: "center",
          }}
        >
          {title}
        </span>
        {/* Raw value */}
        <span
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: 11,
            color: "#A1A1AA",
            textAlign: "center",
          }}
        >
          {detail}
        </span>
      </div>
    </Card>
  );
}

/** Stacked warning(red)/normal(green) histogram over the 1-hour window. */
function EventTimeline({ buckets }: { buckets: EventBucket[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.warnings + b.normal));
  return (
    <div className="flex h-12 items-stretch gap-px rounded-md border bg-muted/30 p-1">
      {buckets.map((b) => {
        const total = b.warnings + b.normal;
        const warnPct = (b.warnings / max) * 100;
        const normPct = (b.normal / max) * 100;
        return (
          <div
            key={b.index}
            className="flex h-full flex-1 flex-col justify-end"
            title={total > 0 ? `${b.warnings} warning, ${b.normal} normal` : undefined}
          >
            <div className="bg-green-600" style={{ height: `${normPct}%` }} />
            <div className="bg-red-600" style={{ height: `${warnPct}%` }} />
          </div>
        );
      })}
    </div>
  );
}

/** One recent-warning row: red bar | reason | target | message | age. */
function WarningRow({ event }: { event: K8sEvent }) {
  const ts = when(event);
  const age = relativeAge(ts);
  const tooltip = absoluteWhen(ts) ?? undefined;
  return (
    <div className="flex items-center gap-2 px-1.5 py-[3px]">
      <span className="h-3 w-0.5 shrink-0 bg-red-600" aria-hidden />
      <span className="w-[140px] shrink-0 truncate font-mono text-[10px]">
        {event.reason ?? "—"}
      </span>
      <span className="w-[200px] shrink-0 truncate font-mono text-[10px] text-muted-foreground">
        {targetLabel(event)}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
        {event.message ?? "—"}
      </span>
      <span className="w-9 shrink-0 text-right font-mono text-[10px] text-muted-foreground" title={tooltip}>
        {age}
      </span>
    </div>
  );
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
