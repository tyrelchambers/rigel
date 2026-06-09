import { useEffect, useMemo } from "react";
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
} from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { cn } from "@/lib/utils";
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
  metricsAvailable,
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

// ---------------------------------------------------------------------------
// DEFERRED (docs/parity/overview.md). This is a READ-ONLY landing dashboard.
// The following are intentionally NOT implemented and must NOT be added without
// a new feature spec + infra:
//   - "Purge an app" button (red, trash) — complex multi-resource deletion;
//     needs its own panel + typed-name confirm sheet spec.
//     TODO: Purge flow (deferred, see docs/parity/purge.md when available).
//   - "Investigate cluster" button (primary, sparkles) — chat/Claude handoff.
//     TODO: Investigate handoff (deferred, see docs/parity/chat-overview.md).
//   - Event timeline drilldown — the ribbon is display-only here.
//   - Any mutation, ConfirmSheet, dialog, or action dispatch.
//   - Namespace-scoped aggregation — Overview is always cluster-wide.
// ---------------------------------------------------------------------------

const TIMELINE_SPAN_SECONDS = 3600;
const TIMELINE_BUCKETS = 60;
const MAX_RECENT_WARNINGS = 10;

export default function OverviewPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);

  // Subscribe to the five cluster-wide watches on mount; unsubscribe on unmount.
  // All cluster-scoped: namespace "*" (Overview never applies the namespace
  // filter — aggregates are always cluster-wide).
  useEffect(() => {
    subscribe("nodes", "*");
    subscribe("pods", "*");
    subscribe("deployments", "*");
    subscribe("events", "*");
    subscribe("namespaces", "*");
    return () => {
      unsubscribe("nodes", "*");
      unsubscribe("pods", "*");
      unsubscribe("deployments", "*");
      unsubscribe("events", "*");
      unsubscribe("namespaces", "*");
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
  // Optional metrics-server feed, keyed by node name. Not yet pushed by the
  // server, so this is normally empty → the metrics fallback card renders.
  const nodeMetrics = useMemo(
    () => (resources["nodemetrics"] ?? {}) as Record<string, NodeMetrics>,
    [resources],
  );

  // --- Derived card data ---------------------------------------------------
  const totals = useMemo(() => clusterResourceTotals(nodes, nodeMetrics), [nodes, nodeMetrics]);
  const hasMetrics = metricsAvailable(nodeMetrics);

  const deployUnhealthy = unhealthyDeploymentCount(deployments);
  const phases = useMemo(() => phaseCounts(pods), [pods]);
  const nodeReady = nodeReadyCount(nodes);
  const pressure = nodePressureCount(nodes);

  const warnings = useMemo(() => events.filter(isWarning), [events]);
  const recentWarnings = warnings.slice(0, MAX_RECENT_WARNINGS);

  const buckets = useMemo(
    () => eventBuckets(events, Date.now(), TIMELINE_SPAN_SECONDS, TIMELINE_BUCKETS),
    [events],
  );

  return (
    <div className="h-full space-y-4 overflow-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Overview</h1>
        {isLoading && (
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-label="loading" />
        )}
        {/* TODO: Purge / Investigate buttons (deferred — see DEFERRED block above) */}
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
        {/* MVP stub: full Databases detection (CNPG + image parsing) is deferred. */}
        <Card title="Databases" icon={<Database className="size-3.5" />}>
          <Metric value={0} caption={plural(0, "instance")} />
          <HealthLine label="Unhealthy" count={0} tone="red" />
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

/** Ring gauge: a circular progress indicator with a centered percentage. */
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
  return (
    <Card title={title} icon={<Gauge className="size-3.5" />}>
      <div className="flex items-center gap-3">
        <div
          className="size-14 shrink-0 rounded-full"
          style={{
            background: `conic-gradient(var(--color-accent, currentColor) ${pct}%, color-mix(in srgb, currentColor 12%, transparent) 0)`,
          }}
        >
          <div className="flex size-full items-center justify-center">
            <div className="flex size-10 items-center justify-center rounded-full bg-background font-mono text-xs font-semibold">
              {pct}%
            </div>
          </div>
        </div>
        <div className="min-w-0">
          <div className="font-mono text-sm">{detail}</div>
        </div>
      </div>
    </Card>
  );
}

/** Stacked warning(red)/normal(green) histogram over the 1-hour window. */
function EventTimeline({ buckets }: { buckets: EventBucket[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.warnings + b.normal));
  return (
    <div className="flex h-12 items-end gap-px rounded-md border bg-muted/30 p-1">
      {buckets.map((b) => {
        const total = b.warnings + b.normal;
        const warnPct = (b.warnings / max) * 100;
        const normPct = (b.normal / max) * 100;
        return (
          <div
            key={b.index}
            className="flex flex-1 flex-col justify-end"
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
