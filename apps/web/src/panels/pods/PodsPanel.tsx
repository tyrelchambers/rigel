import { useEffect, useMemo, useState } from "react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { handoffToChat } from "@/lib/chatHandoff";
import { viewYaml } from "@/store/yamlViewer";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { Sparkline } from "@/components/Sparkline";
import { useMetricsHistory } from "@/lib/useMetricsHistory";
import { ListRow } from "@/panels/components/ListRow";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { StatusBadge } from "@/panels/components/StatusBadge";
import { PanelHeader } from "@/panels/components/PanelHeader";
import { LoadingState } from "@/panels/components/LoadingState";
import { buildHandoffPrompt } from "@/panels/components/chatHandoffPrompts";
import { RelatedResources } from "@/panels/components/RelatedResources";
import { useFocusRow } from "@/panels/components/useFocusRow";
import type { ActionBlock } from "@/lib/api";
import type { Pod } from "./types";
import {
  relativeAge,
  phaseColorClass,
  phaseVariant,
  podNameColorClass,
  readyText,
  restartCount,
  matchesSearch,
  sortPods,
} from "./podDisplay";

export default function PodsPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);

  const [search, setSearch] = useState("");
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { available: metricsAvailable, history: metricsHistory } = useMetricsHistory();

  // Subscribe to the pods watch for the active namespace (or all namespaces).
  useEffect(() => {
    const ns = namespaceFilter ?? "*";
    subscribe("pods", ns);
    return () => unsubscribe("pods", ns);
  }, [namespaceFilter]);

  const allPods = useMemo(
    () => sortPods(Object.values((resources["pods"] ?? {}) as Record<string, Pod>)),
    [resources],
  );
  const filtered = useMemo(
    () => allPods.filter((p) => matchesSearch(p, search)),
    [allPods, search],
  );

  const shown = filtered.length;

  function podKey(pod: Pod): string {
    return pod.metadata.uid || `${pod.metadata.namespace}/${pod.metadata.name}`;
  }

  useFocusRow("pod", allPods, podKey, (k) => setExpanded((prev) => new Set(prev).add(k)));

  function toggleExpand(pod: Pod) {
    const k = podKey(pod);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  function handleDelete(pod: Pod) {
    const ns = pod.metadata.namespace ?? "default";
    setPendingAction({
      kind: "deletePod",
      pod: pod.metadata.name,
      namespace: ns,
      destructive: true,
      label: `Delete pod ${pod.metadata.name}`,
    });
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Pods"
        subtitle="Running containers"
        count={shown}
        loading={isLoading}
      >
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search pods…"
          className="w-56 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </PanelHeader>

      <div className="flex-1 overflow-auto">
      {/* Error banner */}
      {error && (
        <pre className="bg-destructive/10 px-4 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
          {error}
        </pre>
      )}

      {/* Loading state — first load, before any pods have streamed in */}
      {isLoading && allPods.length === 0 && <LoadingState message="Loading pods…" />}

      {/* Row list */}
      <div className="flex flex-col gap-0.5 px-3 py-2">
        {filtered.map((pod) => {
          const k = podKey(pod);
          const isOpen = expanded.has(k);
          const phase = pod.status?.phase;
          const restarts = restartCount(pod);
          const ready = readyText(pod);
          const podHistoryKey = `${pod.metadata.namespace ?? ""}/${pod.metadata.name}`;
          const podMetrics = metricsAvailable ? metricsHistory.get(podHistoryKey) : undefined;

          const rowMenu = (
            <>
              <ContextMenuItem onClick={() => handoffToChat(buildHandoffPrompt("pod", pod.metadata.name, pod.metadata.namespace, "Errors"))}>Ask Claude: Errors</ContextMenuItem>
              <ContextMenuItem onClick={() => handoffToChat(buildHandoffPrompt("pod", pod.metadata.name, pod.metadata.namespace, "Logs"))}>Ask Claude: Logs</ContextMenuItem>
              <ContextMenuItem onClick={() => handoffToChat(buildHandoffPrompt("pod", pod.metadata.name, pod.metadata.namespace, "Explain"))}>Ask Claude: Explain</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onClick={() => handleDelete(pod)}>Delete…</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => viewYaml("pod", pod.metadata.name, pod.metadata.namespace)}>View YAML…</ContextMenuItem>
              <ContextMenuItem onClick={() => toggleExpand(pod)}>{isOpen ? "Collapse" : "Manage…"}</ContextMenuItem>
            </>
          );

          return (
            <ListRow
              key={k}
              rowKey={k}
              isOpen={isOpen}
              onToggle={() => toggleExpand(pod)}
              contextMenu={rowMenu}
              expandedContent={<PodDetail pod={pod} />}
            >
              {/* Name — phase/health-colored */}
              <button
                type="button"
                onClick={() => toggleExpand(pod)}
                className={`shrink-0 font-mono text-xs font-medium leading-none hover:underline ${podNameColorClass(pod)}`}
              >
                {pod.metadata.name}
              </button>

              {/* Namespace chip — dim tertiary */}
              <span
                style={{
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 10,
                  color: "var(--fg-tertiary)",
                  background: "var(--surface-sunken)",
                  padding: "1px 5px",
                  borderRadius: 4,
                  border: "1px solid #26272B",
                  whiteSpace: "nowrap",
                }}
              >
                {pod.metadata.namespace ?? "—"}
              </span>

              {/* Node — dim */}
              {pod.spec?.nodeName && (
                <span
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                    color: "var(--fg-tertiary)",
                    whiteSpace: "nowrap",
                    flexShrink: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    minWidth: 0,
                  }}
                  title={pod.spec.nodeName}
                >
                  {pod.spec.nodeName}
                </span>
              )}

              {/* Spacer */}
              <span className="flex-1" />

              {/* CPU sparkline + value */}
              {podMetrics && podMetrics.cpuSeries.length >= 2 && (
                <span className="inline-flex items-center gap-1 shrink-0">
                  <Sparkline values={podMetrics.cpuSeries} color="#60A5FA" width={40} height={14} />
                  <span
                    style={{
                      fontFamily: "ui-monospace, monospace",
                      fontSize: 10,
                      color: "var(--fg-secondary)",
                    }}
                  >
                    {podMetrics.cpuNow}m
                  </span>
                </span>
              )}

              {/* Memory sparkline + value */}
              {podMetrics && podMetrics.memSeries.length >= 2 && (
                <span className="inline-flex items-center gap-1 shrink-0">
                  <Sparkline values={podMetrics.memSeries} color="#34D399" width={40} height={14} />
                  <span
                    style={{
                      fontFamily: "ui-monospace, monospace",
                      fontSize: 10,
                      color: "var(--fg-secondary)",
                    }}
                  >
                    {podMetrics.memNow}Mi
                  </span>
                </span>
              )}

              {/* Phase badge */}
              {phase && (
                <StatusBadge
                  label={phase}
                  variant={phaseVariant(phase)}
                  title={`Phase: ${phase}`}
                />
              )}

              {/* Ready badge */}
              <StatusBadge
                label={ready}
                variant={ready !== "—" && ready.split("/")[0] === ready.split("/")[1] ? "healthy" : "neutral"}
                title={`Ready: ${ready}`}
              />

              {/* Restart count — amber/red when > 0 */}
              {restarts > 0 && (
                <span
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                    fontWeight: 500,
                    color: restarts >= 5 ? "var(--status-failed)" : "var(--status-pending)",
                    background: restarts >= 5 ? "rgba(239,68,68,0.12)" : "rgba(245,158,11,0.12)",
                    padding: "1px 5px",
                    borderRadius: 4,
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                  title={`Restarts: ${restarts}`}
                >
                  ×{restarts}
                </span>
              )}

            </ListRow>
          );
        })}
      </div>

      {/* Empty / filtered-to-zero states */}
      {!isLoading && allPods.length === 0 && (
        <p className="px-4 py-4 text-sm text-muted-foreground">No pods found</p>
      )}
      {!isLoading && allPods.length > 0 && filtered.length === 0 && (
        <p className="px-4 py-4 text-sm text-muted-foreground">No pods match search</p>
      )}
      </div>

      <ConfirmSheet
        action={pendingAction}
        open={!!pendingAction}
        onClose={() => setPendingAction(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expanded pod detail — containers, IP, node info
// ---------------------------------------------------------------------------

interface PodDetailProps {
  pod: Pod;
}

function PodDetail({ pod }: PodDetailProps) {
  const containers = pod.spec?.containers ?? [];
  const statuses = pod.status?.containerStatuses ?? [];

  return (
    <div className="space-y-3">
      {/* Metadata row */}
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Node</dt>
          <dd className="font-mono">{pod.spec?.nodeName ?? "—"}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">IP</dt>
          <dd className="font-mono">{pod.status?.podIP ?? "—"}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Age</dt>
          <dd className="font-mono">{relativeAge(pod.metadata.creationTimestamp)} ago</dd>
        </div>
      </dl>

      {/* Containers */}
      {containers.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            Containers ({containers.length})
          </h3>
          <ul className="space-y-1">
            {containers.map((c) => {
              const status = statuses.find((s) => s.name === c.name);
              const cRestarts = status?.restartCount ?? 0;
              const phase = status
                ? status.state?.running
                  ? "Running"
                  : status.state?.waiting?.reason ?? "Waiting"
                : "—";
              return (
                <li
                  key={c.name}
                  className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors"
                  style={{ background: "var(--surface-sunken)", border: "1px solid #26272B" }}
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#34353A")}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#26272B")}
                >
                  {/* Phase dot */}
                  <span
                    className={`inline-block size-2 shrink-0 rounded-full ${phaseColorClass(
                      status?.state?.running ? "Running" : status?.state?.waiting ? "Pending" : undefined,
                    )}`}
                  />
                  <span className="font-mono font-medium text-primary shrink-0">{c.name}</span>
                  <span className="font-mono text-muted-foreground truncate min-w-0 flex-1">{c.image ?? "—"}</span>
                  {cRestarts > 0 && (
                    <span
                      className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]"
                      style={{ color: "var(--status-pending)", background: "rgba(245,158,11,0.15)" }}
                      title={`${cRestarts} restart${cRestarts === 1 ? "" : "s"}`}
                    >
                      ↺{cRestarts}
                    </span>
                  )}
                  <span
                    className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                    style={{ background: "var(--surface-elevated)", border: "1px solid #26272B" }}
                  >
                    {phase}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Related resources */}
      <RelatedResources sourceKind="pod" source={pod} />
    </div>
  );
}
