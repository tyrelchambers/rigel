import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  LoaderCircle,
  Hourglass,
  Gauge,
  Copy,
  MessageSquare,
  Check,
} from "lucide-react";
import { useNavigate } from "react-router";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe, sendChat } from "@/lib/ws";
import { Button } from "@/components/ui/button";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import type { ActionBlock } from "@/lib/api";
import {
  formatCpuCores,
  formatMemBytes,
  matchesSearch,
  sortWorkloads,
  suggestionQuantities,
  suggestionYaml,
  verdictStyle,
  MIN_HOURS,
} from "./displayHelper";
import {
  buildRightSizing,
  ingestSamples,
  type PodMetric,
  type SampleStore,
  type WorkloadObject,
} from "./aggregate";
import type {
  RightSizingResult,
  SortMode,
  WorkloadKind,
  WorkloadRightSizing,
} from "./types";

interface PodMetricsResponse {
  available: boolean;
  items: PodMetric[];
}

const KIND_BADGE: Record<WorkloadKind, string> = {
  deployment: "DEP",
  statefulset: "STS",
  daemonset: "DS",
};

/** kubectl workload-kind string for the setResources action block. */
const KIND_KUBECTL: Record<WorkloadKind, string> = {
  deployment: "deployment",
  statefulset: "statefulset",
  daemonset: "daemonset",
};

const SORT_PILLS: Array<{ mode: SortMode; label: string }> = [
  { mode: "needs-attention", label: "Needs attention" },
  { mode: "wasteful", label: "Most wasteful" },
  { mode: "name", label: "Name" },
];

async function fetchPodMetrics(namespace: string): Promise<PodMetricsResponse> {
  const res = await fetch(`/api/metrics/pods?namespace=${encodeURIComponent(namespace)}`);
  if (!res.ok) throw new Error(`metrics fetch failed: ${res.status}`);
  return res.json();
}

export default function RightSizingPanel() {
  const resources = useCluster((s) => s.resources);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);
  const navigate = useNavigate();

  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("needs-attention");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);

  // Subscribe to the three workload kinds + pods (pods drive metric attribution).
  useEffect(() => {
    const ns = namespaceFilter ?? "*";
    subscribe("deployments", ns);
    subscribe("statefulsets", ns);
    subscribe("daemonsets", ns);
    subscribe("pods", ns);
    return () => {
      unsubscribe("deployments", ns);
      unsubscribe("statefulsets", ns);
      unsubscribe("daemonsets", ns);
      unsubscribe("pods", ns);
    };
  }, [namespaceFilter]);

  // Poll current pod metrics every 15s.
  const [metrics, setMetrics] = useState<PodMetricsResponse | null>(null);
  const [isLoadingMetrics, setLoadingMetrics] = useState(true);
  useEffect(() => {
    let cancelled = false;
    const ns = namespaceFilter ?? "*";
    async function poll() {
      try {
        const data = await fetchPodMetrics(ns);
        if (!cancelled) {
          setMetrics(data);
          setLoadingMetrics(false);
        }
      } catch {
        if (!cancelled) setLoadingMetrics(false);
      }
    }
    poll();
    const id = setInterval(poll, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [namespaceFilter]);

  // Rolling in-memory sample accumulator (mirrors the local-history backend).
  const sampleStore = useRef<SampleStore>(new Map());

  // Fold each fresh metrics poll into the accumulator, then recompute verdicts.
  const workloads = useMemo<WorkloadRightSizing[]>(() => {
    const byKind = resources as Record<string, Record<string, WorkloadObject>>;
    const allNames: Array<{ namespace: string; name: string }> = [];
    for (const watchKind of ["deployments", "statefulsets", "daemonsets"]) {
      for (const obj of Object.values(byKind[watchKind] ?? {})) {
        allNames.push({
          namespace: obj.metadata.namespace ?? "default",
          name: obj.metadata.name,
        });
      }
    }
    if (metrics?.available && metrics.items.length > 0) {
      ingestSamples(sampleStore.current, metrics.items, allNames);
    }
    return buildRightSizing(byKind, sampleStore.current);
    // metrics drives re-aggregation; resources drives the workload set.
  }, [resources, metrics]);

  const filtered = useMemo(
    () => sortWorkloads(workloads.filter((w) => matchesSearch(w, search)), sortMode),
    [workloads, search, sortMode],
  );

  // Warming-up: at least one workload, but none has ≥24h of history yet.
  const isWarmingUp =
    workloads.length > 0 &&
    workloads.every((w) =>
      w.containers.every((c) => c.hoursCovered < MIN_HOURS),
    );
  const maxHours = workloads.reduce(
    (m, w) => Math.max(m, ...w.containers.map((c) => c.hoursCovered), 0),
    0,
  );

  const metricsUnavailable = metrics != null && metrics.available === false;

  function toggle(w: WorkloadRightSizing) {
    const k = `${w.namespace}/${w.name}`;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  // --- Container actions ----------------------------------------------------

  function apply(w: WorkloadRightSizing, c: RightSizingResult) {
    const { requests, limits } = suggestionQuantities(c);
    setPendingAction({
      kind: "setResources",
      name: w.name,
      namespace: w.namespace,
      container: c.container,
      resourceKind: KIND_KUBECTL[w.kind],
      requests,
      limits,
      label: `Right-size ${w.name}/${c.container}`,
    });
  }

  function askClaude(w: WorkloadRightSizing, c: RightSizingResult) {
    const style = verdictStyle(c.verdict);
    sendChat(
      `Review right-sizing for ${w.kind} ${w.name} (container ${c.container}) in namespace ${w.namespace}. ` +
        `Current verdict: ${style.label}. ${c.rationale}`,
    );
    navigate("/chat");
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Right-sizing</h1>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground">
          {filtered.length}
        </span>
        {isLoadingMetrics && (
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-label="loading" />
        )}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name or namespace…"
          className="ml-auto w-64 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      {/* Control bar — sort pills */}
      <div className="flex items-center gap-2">
        {SORT_PILLS.map((p) => (
          <button
            key={p.mode}
            type="button"
            onClick={() => setSortMode(p.mode)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              sortMode === p.mode
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Metrics unavailable */}
      {metricsUnavailable && (
        <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          <Gauge className="size-4" />
          Metrics unavailable — install metrics-server to see right-sizing.
        </div>
      )}

      {/* Warming up banner */}
      {!metricsUnavailable && isWarmingUp && (
        <div className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          <Hourglass className="mt-0.5 size-4 shrink-0" />
          <div>
            <div className="font-medium">
              Collecting usage history — recommendations need ~{MIN_HOURS}h of data
            </div>
            <div className="text-xs opacity-80">
              Reading from local history, sampled every ~15s. So far: {maxHours}h of {MIN_HOURS}h.
              Verdicts appear automatically once there's enough.
            </div>
          </div>
        </div>
      )}

      {/* Empty */}
      {!metricsUnavailable && filtered.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-12 text-center text-muted-foreground">
          <Gauge className="size-8" />
          <p className="text-sm font-medium">No workloads to analyze yet</p>
          <p className="text-xs">
            Usage history builds over time; confident verdicts need ~{MIN_HOURS}h of data.
          </p>
        </div>
      )}

      {/* Workload rows */}
      {!metricsUnavailable && filtered.length > 0 && (
        <div className="divide-y rounded-md border">
          {filtered.map((w) => {
            const k = `${w.namespace}/${w.name}`;
            const isOpen = expanded.has(k);
            const style = verdictStyle(w.worst);
            return (
              <Fragment key={k}>
                <button
                  type="button"
                  onClick={() => toggle(w)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted/40"
                  aria-expanded={isOpen}
                >
                  {isOpen ? (
                    <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-mono font-semibold text-primary">
                    {KIND_BADGE[w.kind]}
                  </span>
                  <span className="truncate font-mono text-sm">{w.name}</span>
                  <span className="font-mono text-xs text-muted-foreground/70">
                    {w.namespace}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${style.className}`}
                  >
                    {style.label}
                  </span>
                  {w.reclaimableMemBytes > 0 && (
                    <span className="font-mono text-xs text-amber-600 dark:text-amber-400">
                      reclaim ~{formatMemBytes(w.reclaimableMemBytes)}
                    </span>
                  )}
                  <span className="ml-auto" />
                </button>

                {isOpen && (
                  <div className="space-y-3 bg-muted/20 px-4 py-3">
                    {w.containers.map((c) => (
                      <ContainerDetail
                        key={c.container}
                        workload={w}
                        result={c}
                        onApply={() => apply(w, c)}
                        onAskClaude={() => askClaude(w, c)}
                      />
                    ))}
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
      )}

      <ConfirmSheet
        action={pendingAction}
        open={!!pendingAction}
        onClose={() => setPendingAction(null)}
      />
    </div>
  );
}

/** Per-container detail: verdict, rationale, suggestion table, actions. */
function ContainerDetail({
  workload,
  result,
  onApply,
  onAskClaude,
}: {
  workload: WorkloadRightSizing;
  result: RightSizingResult;
  onApply: () => void;
  onAskClaude: () => void;
}) {
  const style = verdictStyle(result.verdict);
  const insufficient = result.verdict === "insufficientData";
  const hasSuggestion = !insufficient;
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard?.writeText(suggestionYaml(result));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const fmtCpu = (v?: number) => (v == null ? "(unset)" : formatCpuCores(v));
  const fmtMem = (v?: number) => (v == null ? "(unset)" : formatMemBytes(v));

  return (
    <div className="rounded-md border bg-background/60 p-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm font-medium">{result.container}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${style.className}`}>
          {style.label}
        </span>
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {insufficient
            ? `${result.hoursCovered}h/${MIN_HOURS}h`
            : `${result.hoursCovered}h history`}
        </span>
      </div>

      <p className="mt-1 text-xs text-muted-foreground">{result.rationale}</p>

      {hasSuggestion && (
        <div className="mt-2 grid grid-cols-[auto_1fr_auto_1fr_1.4fr] items-center gap-x-3 gap-y-1 text-xs">
          {/* CPU row */}
          <span className="font-medium text-muted-foreground">CPU</span>
          <span className="font-mono">
            {fmtCpu(result.cpuRequest)} / {fmtCpu(result.cpuLimit)}
          </span>
          <span className="text-muted-foreground">→</span>
          <span className="font-mono text-foreground">
            {fmtCpu(result.suggestedCpuRequest)} / {fmtCpu(result.suggestedCpuLimit)}
          </span>
          <span className="font-mono text-muted-foreground/80">
            peak {formatCpuCores(result.cpuPeak)} · typ {formatCpuCores(result.cpuTypical)}
          </span>

          {/* MEM row */}
          <span className="font-medium text-muted-foreground">MEM</span>
          <span className="font-mono">
            {fmtMem(result.memRequest)} / {fmtMem(result.memLimit)}
          </span>
          <span className="text-muted-foreground">→</span>
          <span className="font-mono text-foreground">
            {fmtMem(result.suggestedMemRequest)} / {fmtMem(result.suggestedMemLimit)}
          </span>
          <span className="font-mono text-muted-foreground/80">
            peak {formatMemBytes(result.memPeak)} · typ {formatMemBytes(result.memTypical)}
          </span>
        </div>
      )}

      {hasSuggestion && (
        <div className="mt-3 flex items-center justify-end gap-1">
          <Button variant="ghost" size="sm" onClick={copy} title="Copy YAML snippet">
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button variant="ghost" size="sm" onClick={onAskClaude} title="Discuss in chat">
            <MessageSquare className="size-3.5" />
            Ask Claude
          </Button>
          <Button variant="default" size="sm" onClick={onApply} title="Apply suggested resources">
            Apply
          </Button>
        </div>
      )}
      {/* workload kind hint kept available for downstream tooling */}
      <span className="sr-only">{workload.kind}</span>
    </div>
  );
}
