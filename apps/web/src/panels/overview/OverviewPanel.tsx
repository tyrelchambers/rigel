import { useEffect, useMemo, useState } from "react";
import {
  Layers,
  Box,
  Server,
  Database,
  CalendarClock,
  Activity,
  AlertTriangle,
  History,
  Trash2,
  Sparkles,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { cn } from "@/lib/utils";
import { useNodeMetrics } from "@/lib/api";
import { InfoTooltip } from "@/components/InfoTooltip";
import { Loader } from "@/components/Loader";
import { PurgePickerSheet } from "@/panels/purge/PurgePickerSheet";
import { PurgeSheet } from "@/panels/purge/PurgeSheet";
import { useRightSizing } from "@/panels/rightsizing/useRightSizing";
import { MIN_HOURS } from "@/panels/rightsizing/displayHelper";
import { handoffToChat } from "@/lib/chatHandoff";
import { buildWarningInvestigationPrompt } from "@/panels/components/chatHandoffPrompts";
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
  nodeReadyByName,
  nodePressureCount,
  clusterResourceTotals,
  perNodeResourceTotals,
  formatBytes,
} from "./overviewDisplay";
import { NodeMetricsTable } from "./NodeMetricsTable";
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

// Recent-warnings palette (Pencil redesign).
const WARN_RED = "#FF6B6B";
const WARN_TINT = "rgba(255,90,90,0.1)";
const WARN_MUTED = "#8C8C95";
const WARN_ROW_BG = "#141417";

interface OverviewPanelProps {
  /** Called when the user clicks "Investigate cluster" — injects the prompt into the chat pane. */
  onInvestigateCluster?: () => void;
}

export default function OverviewPanel({ onInvestigateCluster }: OverviewPanelProps) {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);

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
  // but forced cluster-wide so it matches the rest of this dashboard (the
  // Right-Sizing panel itself stays namespace-scoped).
  const { workloads: rsWorkloads, usingBackend: rsBackend } = useRightSizing({ clusterWide: true });
  const reclaimBytes = useMemo(
    () => rsWorkloads.reduce((sum, w) => sum + Math.max(0, w.reclaimableMemBytes), 0),
    [rsWorkloads],
  );
  // Backend connected but still scraping its first ~MIN_HOURS — mirror the
  // Right-Sizing tab's "collecting data" state instead of a misleading 0% gauge.
  const rsWarmingUp =
    rsBackend &&
    rsWorkloads.length > 0 &&
    rsWorkloads.every((w) => w.containers.every((c) => c.hoursCovered < MIN_HOURS));

  const readyByName = useMemo(() => nodeReadyByName(nodes), [nodes]);
  const reclaimable =
    rsBackend && !rsWarmingUp && totals.memAllocatable > 0
      ? {
          fraction: Math.min(1, reclaimBytes / totals.memAllocatable),
          detail: `${formatBytes(String(reclaimBytes))} of ${formatBytes(String(totals.memAllocatable))}`,
        }
      : null;

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
              <Loader size={16} className="text-muted-foreground" label="loading" />
            )}
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

        {/* Row 1 — Dense per-node metrics table (Layout C) + reclaimable badge */}
        <div className="ov-row">
          <NodeMetricsTable
            rows={perNode}
            readyByName={readyByName}
            hasMetrics={hasMetrics}
            reclaimable={reclaimable}
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

        {/* Recent warnings — up to 10, newest first (Pencil redesign) */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 16,
            background: "#0E0E11",
            border: "1px solid rgba(255,255,255,0.07)",
            borderRadius: 12,
            padding: 18,
          }}
        >
          {/* Header — alert badge + title + count pill, with a window label */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center" style={{ gap: 11 }}>
              <span
                className="inline-flex items-center justify-center"
                style={{ width: 30, height: 30, borderRadius: 9, background: WARN_TINT }}
              >
                <AlertTriangle size={16} style={{ color: WARN_RED }} />
              </span>
              <span style={{ fontSize: 16, fontWeight: 700, color: "#FFFFFF" }}>Recent warnings</span>
              {warnings.length > 0 && (
                <span
                  className="inline-flex items-center justify-center"
                  style={{ borderRadius: 999, background: WARN_TINT, padding: "3px 10px", fontSize: 12, fontWeight: 600, color: WARN_RED }}
                >
                  {warnings.length}
                </span>
              )}
            </div>
            <span
              className="inline-flex items-center"
              style={{ gap: 6, borderRadius: 8, border: "1px solid rgba(255,255,255,0.07)", padding: "6px 11px", fontSize: 12, fontWeight: 500, color: WARN_MUTED }}
            >
              <History size={13} /> Last hour
            </span>
          </div>

          {recentWarnings.length === 0 ? (
            <p style={{ fontSize: 13, color: WARN_MUTED }}>No warning events.</p>
          ) : (
            <>
              <div className="flex flex-col" style={{ gap: 8 }}>
                {recentWarnings.map((e) => (
                  <WarningRow
                    key={e.metadata.uid}
                    event={e}
                    onInvestigate={() => handoffToChat(buildWarningInvestigationPrompt(e), { newThread: true })}
                  />
                ))}
              </div>
              <div style={{ fontSize: 13, color: WARN_MUTED, paddingTop: 2 }}>
                Showing {recentWarnings.length} of {warnings.length} {plural(warnings.length, "warning")}
              </div>
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

/**
 * One recent-warning row (Pencil redesign, no red left border): a left status
 * column (severity pill + kind) and a body (resource + namespace chip + time,
 * then the message).
 */
export function WarningRow({
  event,
  onInvestigate,
}: {
  event: K8sEvent;
  onInvestigate?: () => void;
}) {
  const ts = when(event);
  const age = relativeAge(ts);
  const tooltip = absoluteWhen(ts) ?? undefined;
  const io = event.involvedObject;
  const kind = io?.kind ?? "";
  const name = io?.name ?? "";
  const resource = name ? (kind ? `${kind}/${name}` : name) : "—";
  const ns = io?.namespace;
  const reason = event.reason ?? "Warning";

  return (
    <div
      className="flex"
      style={{ gap: 20, background: WARN_ROW_BG, borderRadius: 12, border: "1px solid rgba(255,255,255,0.05)", padding: "14px 16px" }}
    >
      {/* Status column */}
      <div className="flex flex-col" style={{ gap: 8, width: 170, flexShrink: 0, minWidth: 0 }}>
        <span
          className="inline-flex items-center self-start"
          title={reason}
          style={{ maxWidth: "100%", gap: 6, borderRadius: 999, background: WARN_TINT, padding: "4px 11px" }}
        >
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: WARN_RED, flexShrink: 0 }} />
          <span
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: 12.5,
              fontWeight: 600,
              color: WARN_RED,
            }}
          >
            {reason}
          </span>
        </span>
        {kind && (
          <span className="inline-flex items-center" style={{ gap: 6 }}>
            <Box size={13} style={{ color: WARN_MUTED }} />
            <span style={{ fontSize: 12, fontWeight: 500, color: WARN_MUTED }}>{kind}</span>
          </span>
        )}
      </div>

      {/* Body */}
      <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 7 }}>
        {/* Resource title, namespace tag, and age — all inline */}
        <div className="flex min-w-0 items-center" style={{ gap: 9 }}>
          <span
            title={resource}
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontFamily: "ui-monospace, monospace",
              fontSize: 13,
              fontWeight: 500,
              color: "#A6A6AE",
            }}
          >
            {resource}
          </span>
          {ns && (
            <span
              className="shrink-0"
              style={{ borderRadius: 6, background: "rgba(255,255,255,0.05)", padding: "3px 9px", fontFamily: "ui-monospace, monospace", fontSize: 11, color: WARN_MUTED }}
            >
              {ns}
            </span>
          )}
          <span className="shrink-0" style={{ fontSize: 12.5, fontWeight: 500, color: WARN_MUTED }} title={tooltip}>
            {age}
          </span>
        </div>
        <span style={{ fontSize: 13, lineHeight: 1.5, color: "#B9B9C1" }}>{event.message ?? "—"}</span>
      </div>

      {/* Investigate (AI) — trailing, vertically centered */}
      <div className="flex shrink-0 items-center">
        <button
          type="button"
          onClick={onInvestigate}
          title="Investigate this warning with AI"
          className="shrink-0"
          style={{
            display: "inline-flex",
            alignItems: "center",
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 7,
            padding: "5px 11px",
            fontSize: 12,
            fontWeight: 600,
            color: "#D8D8DE",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          Investigate
        </button>
      </div>
    </div>
  );
}

/** Pluralize a noun by count: 1 → "1 deployment", else "N deployments". */
function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}
