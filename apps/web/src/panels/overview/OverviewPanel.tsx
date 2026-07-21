import { Fragment, useEffect, useMemo, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faLayerGroup,
  faCube,
  faServer,
  faDatabase,
  faCalendarClock,
  faTriangleExclamation,
  faClockRotateLeft,
  faTrashCan,
  faSparkles,
} from "@awesome.me/kit-6050953220/icons/classic/solid";
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
  K8sEvent,
  Node,
  NodeMetrics,
  Pod,
} from "./types";
import {
  phaseCounts,
  nodeReadyCount,
  nodeReadyByName,
  clusterResourceTotals,
  perNodeResourceTotals,
  formatBytes,
} from "./overviewDisplay";
import { NodeMetricsTable } from "./NodeMetricsTable";
import { RecentDeploysCard } from "./RecentDeploysCard";
import {
  sortEvents,
  isWarning,
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
  const namespaceFilter = useCluster((s) => s.namespaceFilter);

  // Scope namespaced lists to the selected namespace (null = All namespaces).
  // Cluster-scoped kinds (nodes) are never filtered — a namespace doesn't apply.
  const inNamespace = useMemo(
    () =>
      <T extends { metadata?: { namespace?: string } }>(list: T[]): T[] =>
        namespaceFilter ? list.filter((o) => o.metadata?.namespace === namespaceFilter) : list,
    [namespaceFilter],
  );

  // Purge flow: picker → typed-name confirm sheet.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState<{ name: string; namespace: string } | null>(null);

  // Subscribe to the cluster-wide watches on mount; unsubscribe on unmount. Data
  // is always fetched at "*" so the namespaced cards can be scoped client-side
  // (via inNamespace) and "All namespaces" still shows the full cluster.
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
    () => inNamespace(Object.values((resources["pods"] ?? {}) as Record<string, Pod>)),
    [resources, inNamespace],
  );
  const deployments = useMemo(
    () => inNamespace(Object.values((resources["deployments"] ?? {}) as Record<string, Deployment>)),
    [resources, inNamespace],
  );
  const events = useMemo(
    () => sortEvents(inNamespace(Object.values((resources["events"] ?? {}) as Record<string, K8sEvent>))),
    [resources, inNamespace],
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

  const phases = useMemo(() => phaseCounts(pods), [pods]);
  const nodeReady = nodeReadyCount(nodes);

  // Detected databases — CNPG clusters + image-detected workloads (same logic
  // as the Databases panel), so the count matches instead of a 0 stub.
  const databases = useMemo(
    () =>
      buildInstances({
        cnpgClusters: inNamespace(
          Object.values((resources["clusters.postgresql.cnpg.io"] ?? {}) as Record<string, CNPGCluster>),
        ),
        scheduledBackups: inNamespace(
          Object.values(
            (resources["scheduledbackups.postgresql.cnpg.io"] ?? {}) as Record<string, CNPGScheduledBackup>,
          ),
        ),
        deployments: deployments as unknown as WorkloadDB[],
        statefulSets: inNamespace(
          Object.values((resources["statefulsets"] ?? {}) as Record<string, WorkloadDB>),
        ),
      }),
    [resources, deployments, inNamespace],
  );

  const warnings = useMemo(() => events.filter(isWarning), [events]);
  const recentWarnings = warnings.slice(0, MAX_RECENT_WARNINGS);

  const barStats: BarStat[] = [
    { icon: faLayerGroup, value: deployments.length, label: "Deployments" },
    {
      icon: faCube,
      value: pods.length,
      label: "Pods",
      dots: [
        { on: phases.running > 0, tone: "green" },
        { on: phases.pending > 0, tone: "yellow" },
        { on: phases.failed > 0, tone: "red" },
      ],
    },
    { icon: faServer, value: `${nodeReady.ready}/${nodeReady.total}`, label: "Nodes" },
    { icon: faDatabase, value: databases.length, label: "Databases" },
    { icon: faCalendarClock, value: events.length, label: "Events" },
  ];

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
            <FontAwesomeIcon icon={faTrashCan} className="ov-btn-icon" />
            Purge an app
          </button>
          <button className="ov-btn-investigate" onClick={onInvestigateCluster}>
            <FontAwesomeIcon icon={faSparkles} className="ov-btn-icon" />
            Investigate cluster
          </button>
        </div>
      </div>

      {/* Scroll area */}
      <div className="ov-content">
        {error && <pre className="ov-error">{error}</pre>}

        <StatBar stats={barStats} />

        {/* Dense per-node metrics table (Layout C) + reclaimable badge */}
        <div className="ov-row">
          <NodeMetricsTable
            rows={perNode}
            readyByName={readyByName}
            hasMetrics={hasMetrics}
            metricsAvailable={nodeMetricsData?.available === true}
            reclaimable={reclaimable}
          />
        </div>

        {/* Recent warnings — up to 10, newest first (Pencil redesign) */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 16,
            background: "var(--surface-elevated)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 8,
            padding: 18,
          }}
        >
          {/* Header — alert badge + title + count pill, with a window label */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center" style={{ gap: 11 }}>
              <span
                className="inline-flex items-center justify-center"
                style={{ width: 30, height: 30, borderRadius: 9, background: "rgba(255,255,255,0.08)" }}
              >
                <FontAwesomeIcon icon={faTriangleExclamation} className="size-[16px]" style={{ color: "var(--fg-primary)" }} />
              </span>
              <span className="text-base" style={{ fontWeight: 700, color: "#FFFFFF" }}>Recent warnings</span>
              {warnings.length > 0 && (
                <span
                  className="inline-flex items-center justify-center text-xs"
                  style={{ borderRadius: 999, background: WARN_TINT, padding: "3px 10px", fontWeight: 600, color: WARN_RED }}
                >
                  {warnings.length}
                </span>
              )}
            </div>
            <span
              className="inline-flex items-center text-xs"
              style={{ gap: 6, borderRadius: 8, border: "1px solid rgba(255,255,255,0.07)", padding: "6px 11px", fontWeight: 500, color: WARN_MUTED }}
            >
              <FontAwesomeIcon icon={faClockRotateLeft} className="size-[13px]" /> Last hour
            </span>
          </div>

          {recentWarnings.length === 0 ? (
            <p className="text-xs" style={{ color: WARN_MUTED }}>No warning events.</p>
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
              <div className="text-xs" style={{ color: WARN_MUTED, paddingTop: 2 }}>
                Showing {recentWarnings.length} of {warnings.length} {plural(warnings.length, "warning")}
              </div>
            </>
          )}
        </div>

        {/* Recent deployments — batches Rigel applied, with per-batch undo */}
        <div className="ov-row">
          <RecentDeploysCard />
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

type DotTone = "green" | "yellow" | "red";

const DOT_CLASS: Record<DotTone, string> = {
  green: "bg-[var(--status-running)]",
  yellow: "bg-[var(--status-pending)]",
  red: "bg-[var(--status-failed)]",
};

type BarStat = {
  icon: IconDefinition;
  value: number | string;
  label: string;
  dots?: { on: boolean; tone: DotTone }[];
};

/** Compact inline stat line: icon + value + label per metric, separated by thin
 *  dividers. Pods carries a running/pending/failed dot glyph. */
function StatBar({ stats }: { stats: BarStat[] }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-7 py-4">
      {stats.map((s, i) => (
        <Fragment key={s.label}>
          {i > 0 && <span aria-hidden="true" className="h-6 w-px shrink-0 bg-[var(--border-subtle)]" />}
          <div className="flex items-center gap-2.5">
            <FontAwesomeIcon icon={s.icon} className="size-[15px] shrink-0 text-[var(--fg-tertiary)]" />
            <span className="text-xl font-bold leading-none tabular-nums text-[var(--fg-primary)]">{s.value}</span>
            <span className="text-sm font-medium text-[var(--fg-secondary)]">{s.label}</span>
            {s.dots && (
              <span aria-hidden="true" className="flex items-center gap-1">
                {s.dots.map((d, j) => (
                  <span key={j} className={cn("size-[7px] rounded-full", d.on ? DOT_CLASS[d.tone] : "bg-white/10")} />
                ))}
              </span>
            )}
          </div>
        </Fragment>
      ))}
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
            className="text-xs"
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontWeight: 600,
              color: WARN_RED,
            }}
          >
            {reason}
          </span>
        </span>
        {kind && (
          <span className="inline-flex items-center" style={{ gap: 6 }}>
            <FontAwesomeIcon icon={faCube} className="size-[13px]" style={{ color: WARN_MUTED }} />
            <span className="text-xs" style={{ fontWeight: 500, color: WARN_MUTED }}>{kind}</span>
          </span>
        )}
      </div>

      {/* Body */}
      <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 7 }}>
        {/* Resource title, namespace tag, and age — all inline */}
        <div className="flex min-w-0 items-center" style={{ gap: 9 }}>
          <span
            title={resource}
            className="text-xs"
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontFamily: "ui-monospace, monospace",
              fontWeight: 500,
              color: "#A6A6AE",
            }}
          >
            {resource}
          </span>
          {ns && (
            <span
              className="shrink-0 text-2xs"
              style={{ borderRadius: 6, background: "rgba(255,255,255,0.05)", padding: "3px 9px", fontFamily: "ui-monospace, monospace", color: WARN_MUTED }}
            >
              {ns}
            </span>
          )}
          <span className="shrink-0 text-xs" style={{ fontWeight: 500, color: WARN_MUTED }} title={tooltip}>
            {age}
          </span>
        </div>
        <span className="text-xs" style={{ lineHeight: 1.5, color: "#B9B9C1" }}>{event.message ?? "—"}</span>
      </div>

      {/* Investigate (AI) — trailing, vertically centered */}
      <div className="flex shrink-0 items-center">
        <button
          type="button"
          onClick={onInvestigate}
          title="Investigate this warning with AI"
          className="shrink-0 text-xs"
          style={{
            display: "inline-flex",
            alignItems: "center",
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 7,
            padding: "5px 11px",
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
