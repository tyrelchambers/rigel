import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowUp,
  ArrowDown,
  RotateCcw,
  RefreshCw,
  SlidersHorizontal,
  Undo2,
  Pause,
  Play,
  Box,
  Cpu,
  MemoryStick,
} from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { handoffToChat } from "@/lib/chatHandoff";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { ListRow } from "@/panels/components/ListRow";
import { TagPill } from "@/panels/components/TagPill";
import { StatusBadge } from "@/panels/components/StatusBadge";
import { ActionButtonStrip } from "@/panels/components/ActionButtonStrip";
import { PanelHeader } from "@/panels/components/PanelHeader";
import { LoadingState } from "@/panels/components/LoadingState";
import { buildHandoffPrompt } from "@/panels/components/chatHandoffPrompts";
import { KeyValueEditor } from "@/panels/components/KeyValueEditor";
import type { ActionBlock } from "@/lib/api";
import type { KVRow } from "@helmsman/k8s";
import type { Deployment } from "./types";
import type { Pod } from "../pods/types";
import {
  relativeAge,
  readyText,
  isReady,
  statusColor,
  imageRepo,
  imageTag,
  firstImage,
  containerSummaries,
  strategyDescription,
  selectorString,
  isRedeploying,
  rolloutProgress,
  childPods,
  totalReplicas,
  matchesSearch,
  sortDeployments,
  editModelFor,
  diffDeployment,
  type DeploymentEdit,
} from "./deploymentDisplay";
import {
  relativeAge as podAge,
  phaseColorClass,
  readyText as podReady,
  restartCount,
} from "../pods/podDisplay";

export default function DeploymentsPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);
  const focusRequest = useCluster((s) => s.focusRequest);
  const setFocusRequest = useCluster((s) => s.setFocusRequest);

  const [search, setSearch] = useState("");
  const [pendingActions, setPendingActions] = useState<ActionBlock[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editTarget, setEditTarget] = useState<Deployment | null>(null);
  const [editModel, setEditModel] = useState<DeploymentEdit | null>(null);

  useEffect(() => {
    const ns = namespaceFilter ?? "*";
    subscribe("deployments", ns);
    subscribe("pods", ns);
    return () => {
      unsubscribe("deployments", ns);
      unsubscribe("pods", ns);
    };
  }, [namespaceFilter]);

  const allDeployments = useMemo(
    () =>
      sortDeployments(
        Object.values((resources["deployments"] ?? {}) as Record<string, Deployment>),
      ),
    [resources],
  );
  const allPods = useMemo(
    () => Object.values((resources["pods"] ?? {}) as Record<string, Pod>),
    [resources],
  );
  const filtered = useMemo(
    () => allDeployments.filter((d) => matchesSearch(d, search)),
    [allDeployments, search],
  );

  function key(d: Deployment): string {
    return d.metadata.uid || `${d.metadata.namespace}/${d.metadata.name}`;
  }

  useEffect(() => {
    if (focusRequest?.kind !== "deployment") return;
    const match = allDeployments.find(
      (d) => (d.metadata.uid ?? `${d.metadata.namespace}/${d.metadata.name}`) === focusRequest.key,
    );
    if (!match) return; // not streamed yet; effect re-runs when allDeployments updates
    const k = key(match);
    setExpanded((prev) => new Set(prev).add(k));
    setFocusRequest(null);
    setTimeout(() => {
      document.querySelector(`[data-row-key="${CSS.escape(k)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 50);
  }, [focusRequest, allDeployments]);

  useEffect(() => {
    return () => {
      if (useCluster.getState().focusRequest?.kind === "deployment") {
        useCluster.getState().setFocusRequest(null);
      }
    };
  }, []);

  function toggleExpand(d: Deployment) {
    const k = key(d);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  // --- Mutation action builders --------------------------------------------

  function restart(d: Deployment) {
    setPendingActions([{
      kind: "restart",
      name: d.metadata.name,
      namespace: d.metadata.namespace ?? "default",
      label: `Restart deployment ${d.metadata.name}`,
    }]);
  }

  function rollback(d: Deployment) {
    setPendingActions([{
      kind: "rollback",
      name: d.metadata.name,
      namespace: d.metadata.namespace ?? "default",
      label: `Rollback ${d.metadata.name} to previous version`,
    }]);
  }

  function togglePause(d: Deployment) {
    const paused = d.spec?.paused === true;
    setPendingActions([{
      kind: paused ? "resume" : "pause",
      name: d.metadata.name,
      namespace: d.metadata.namespace ?? "default",
      label: paused
        ? `Resume rollout of ${d.metadata.name}`
        : `Pause rollout of ${d.metadata.name}`,
    }]);
  }

  function openEdit(d: Deployment) {
    setEditModel(editModelFor(d));
    setEditTarget(d);
  }

  function saveEdit() {
    if (!editTarget || !editModel) return;
    const actions = diffDeployment(editTarget, editModel);
    setEditTarget(null);
    if (actions.length > 0) setPendingActions(actions);
  }

  function updateContainer(idx: number, patch: Partial<DeploymentEdit["containers"][number]>) {
    setEditModel((m) => (m ? { ...m, containers: m.containers.map((c, i) => (i === idx ? { ...c, ...patch } : c)) } : m));
  }

  // --- Chat handoff -------------------------------------------------------

  function askClaude(d: Deployment, topic: "Errors" | "Logs" | "Explain" | "Rollout") {
    handoffToChat(buildHandoffPrompt("deployment", d.metadata.name, d.metadata.namespace, topic));
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Deployments"
        subtitle="Rollouts & replicas"
        count={filtered.length}
        loading={isLoading}
      >
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search deployments…"
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

        {/* Loading state — first load, before any deployments have streamed in */}
        {isLoading && allDeployments.length === 0 && <LoadingState message="Loading deployments…" />}

        {/* Row list */}
        <div className="flex flex-col gap-0.5 px-3 py-2">
        {filtered.map((d) => {
          const k = key(d);
          const isOpen = expanded.has(k);
          const image = firstImage(d);
          const pods = childPods(d, allPods);
          const redeploying = isRedeploying(d, allPods);
          const total = totalReplicas(d);
          const updated = d.status?.updatedReplicas ?? 0;
          const paused = d.spec?.paused === true;
          const progress = rolloutProgress(d);

          return (
            <ListRow
              key={k}
              rowKey={k}
              isOpen={isOpen}
              onToggle={() => toggleExpand(d)}
              progress={redeploying ? progress : undefined}
              overlay={
                redeploying ? (
                  <div
                    className="pointer-events-none absolute inset-0"
                    style={{
                      background:
                        "linear-gradient(to right, rgba(16,185,129,0.18) 0%, transparent 55%)",
                    }}
                  />
                ) : undefined
              }
              expandedContent={
                <DeploymentDetail
                  deployment={d}
                  pods={pods}
                  paused={paused}
                  onEdit={() => openEdit(d)}
                  onRestart={() => restart(d)}
                  onRollback={() => rollback(d)}
                  onTogglePause={() => togglePause(d)}
                />
              }
            >
              {/* Name — health-colored */}
              <button
                type="button"
                onClick={() => toggleExpand(d)}
                className={`shrink-0 font-mono text-xs font-medium leading-none hover:underline ${statusColor(d, allPods)}`}
              >
                {d.metadata.name}
              </button>

              {/* Namespace — dim tertiary chip */}
              <span
                style={{
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 10,
                  color: "#6B6B73",
                  background: "#050505",
                  padding: "1px 5px",
                  borderRadius: 4,
                  border: "1px solid #1A1A1A",
                  whiteSpace: "nowrap",
                }}
              >
                {d.metadata.namespace ?? "—"}
              </span>

              {/* Image repo — dim, truncated */}
              {image && imageRepo(image) !== "—" && (
                <span
                  title={image}
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                    color: "#A1A1AA",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                    flexShrink: 1,
                  }}
                >
                  {imageRepo(image)}
                </span>
              )}

              {/* Tag pill — shared accent purple */}
              {image && <TagPill label={imageTag(image)} title={image} />}

              {/* Spacer */}
              <span className="flex-1" />

              {/* Rollout churn chips — only while live */}
              {redeploying && (
                <span className="inline-flex items-center gap-1.5 text-[10px]">
                  {updated > 0 && (
                    <span
                      className="inline-flex items-center gap-0.5"
                      style={{ color: "#10B981" }}
                      title={`${updated} new pod(s) up`}
                    >
                      <ArrowUp className="size-2.5" />
                      {updated}
                    </span>
                  )}
                  {Math.max(0, total - updated) > 0 && (
                    <span
                      className="inline-flex items-center gap-0.5"
                      style={{ color: "#F59E0B" }}
                      title={`${Math.max(0, total - updated)} old terminating`}
                    >
                      <ArrowDown className="size-2.5" />
                      {Math.max(0, total - updated)}
                    </span>
                  )}
                </span>
              )}

              {/* Ready badge — shared StatusBadge */}
              <StatusBadge
                label={readyText(d)}
                variant={isReady(d) ? "healthy" : "error"}
              />

              {/* Action button strip — Errors / Logs / Explain / Rollout */}
              <ActionButtonStrip
                onErrors={(e) => { e.stopPropagation(); askClaude(d, "Errors"); }}
                onLogs={(e) => { e.stopPropagation(); askClaude(d, "Logs"); }}
                onExplain={(e) => { e.stopPropagation(); askClaude(d, "Explain"); }}
                extra={[
                  {
                    label: "Rollout",
                    Icon: RotateCcw,
                    onClick: (e) => { e.stopPropagation(); askClaude(d, "Rollout"); },
                  },
                ]}
              />
            </ListRow>
          );
        })}
      </div>

      {/* Empty / filtered-to-zero states */}
      {!isLoading && allDeployments.length === 0 && (
        <p className="px-4 py-4 text-sm text-muted-foreground">No deployments found</p>
      )}
      {!isLoading && allDeployments.length > 0 && filtered.length === 0 && (
        <p className="px-4 py-4 text-sm text-muted-foreground">No deployments match search</p>
      )}
      </div>

      {/* Config editor dialog */}
      <Dialog open={!!editTarget} onOpenChange={(o) => { if (!o) setEditTarget(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit {editTarget?.metadata.name}</DialogTitle>
            <DialogDescription>Changes are applied as kubectl commands you confirm next.</DialogDescription>
          </DialogHeader>
          {editModel && (
            <div className="max-h-[60vh] space-y-4 overflow-auto">
              <label className="flex items-center gap-2 text-sm">
                <span className="w-24 text-muted-foreground">Replicas</span>
                <input
                  type="number" min={0} max={50} value={editModel.replicas}
                  onChange={(e) => setEditModel({ ...editModel, replicas: Math.max(0, Math.min(50, Math.floor(Number(e.target.value) || 0))) })}
                  className="w-24 rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </label>
              {editModel.containers.map((c, ci) => (
                <div key={c.name} className="space-y-2 rounded-md border p-3">
                  <div className="font-mono text-xs font-medium text-primary">{c.name}</div>
                  <label className="flex items-center gap-2 text-xs">
                    <span className="w-20 text-muted-foreground">Image</span>
                    <input
                      value={c.image}
                      onChange={(e) => updateContainer(ci, { image: e.target.value })}
                      className="flex-1 rounded-md border bg-background px-2.5 py-1.5 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {(["cpuReq", "cpuLim", "memReq", "memLim"] as const).map((field) => (
                      <label key={field} className="flex items-center gap-2 text-xs">
                        <span className="w-16 text-muted-foreground">{field === "cpuReq" ? "CPU req" : field === "cpuLim" ? "CPU lim" : field === "memReq" ? "Mem req" : "Mem lim"}</span>
                        <input
                          value={c[field]}
                          onChange={(e) => updateContainer(ci, { [field]: e.target.value })}
                          placeholder={field.startsWith("cpu") ? "e.g. 250m" : "e.g. 256Mi"}
                          className="flex-1 rounded-md border bg-background px-2 py-1 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
                        />
                      </label>
                    ))}
                  </div>
                  <div className="space-y-1.5">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Environment</div>
                    <KeyValueEditor
                      rows={c.env}
                      onRowsChange={(rows: KVRow[]) => updateContainer(ci, { env: rows })}
                      keyPlaceholder="ENV_NAME"
                    />
                    {c.refEnvKeys.length > 0 && (
                      <div className="space-y-1 pt-1">
                        {c.refEnvKeys.map((k) => (
                          <div key={k} className="flex items-center gap-2 rounded border border-dashed px-2 py-1 text-[11px] font-mono text-muted-foreground">
                            <span>{k}</span>
                            <span className="ml-1 text-[10px] uppercase tracking-wide">from ref · read-only</span>
                            <button
                              type="button"
                              className="ml-auto text-destructive hover:underline"
                              onClick={() => updateContainer(ci, { refEnvKeys: c.refEnvKeys.filter((x) => x !== k) })}
                            >
                              remove
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>Cancel</Button>
            <Button onClick={saveEdit}>Review changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmSheet
        actions={pendingActions ?? undefined}
        open={!!pendingActions}
        onClose={() => setPendingActions(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expanded detail: SPEC + PODS + Manage actions
// ---------------------------------------------------------------------------

interface DeploymentDetailProps {
  deployment: Deployment;
  pods: Pod[];
  paused: boolean;
  onRestart: () => void;
  onEdit: () => void;
  onRollback: () => void;
  onTogglePause: () => void;
}

function DeploymentDetail({
  deployment,
  pods,
  paused,
  onRestart,
  onEdit,
  onRollback,
  onTogglePause,
}: DeploymentDetailProps) {
  const containers = containerSummaries(deployment);
  const sortedPods = [...pods].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        {/* SPEC block */}
        <div className="space-y-2">
          <h3 className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            Spec
          </h3>
          <dl className="space-y-1 text-xs">
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted-foreground">Strategy</dt>
              <dd className="font-mono">{strategyDescription(deployment)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted-foreground">Selector</dt>
              <dd className="font-mono">{selectorString(deployment)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted-foreground">Created</dt>
              <dd className="font-mono">{relativeAge(deployment.metadata.creationTimestamp)} ago</dd>
            </div>
          </dl>
          <div className="space-y-2 pt-1">
            {containers.map((c) => (
              <div
                key={c.name}
                className="overflow-hidden rounded-md text-xs"
                style={{ background: "#0A0A0C", border: "1px solid #26262C" }}
              >
                {/* Header strip: container name + ports */}
                <div
                  className="flex items-center gap-2 px-2.5 py-1.5"
                  style={{ background: "#101014", borderBottom: "1px solid #1A1A1A" }}
                >
                  <Box className="size-3 shrink-0 text-muted-foreground" />
                  <span className="font-mono font-medium text-primary">{c.name}</span>
                  {c.ports.length > 0 && (
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                      {c.ports.map((p) => `:${p}`).join(" ")}
                    </span>
                  )}
                </div>
                {/* Body: image + resource cells */}
                <div className="space-y-2 px-2.5 py-2">
                  <div className="font-mono text-[11px] text-muted-foreground break-all">{c.image}</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <ResourceCell
                      icon={<Cpu className="size-3 shrink-0 text-muted-foreground" />}
                      label="CPU"
                      req={c.cpuReq}
                      lim={c.cpuLim}
                    />
                    <ResourceCell
                      icon={<MemoryStick className="size-3 shrink-0 text-muted-foreground" />}
                      label="MEM"
                      req={c.memReq}
                      lim={c.memLim}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* PODS block */}
        <div className="space-y-2">
          <h3 className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            Pods ({sortedPods.length})
          </h3>
          {sortedPods.length === 0 ? (
            <p className="text-xs text-muted-foreground">No matching pods</p>
          ) : (
            <ul className="space-y-1">
              {sortedPods.map((p) => {
                const restarts = restartCount(p);
                return (
                  <li
                    key={p.metadata.uid || p.metadata.name}
                    className="group flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors"
                    style={{ background: "#0A0A0C", border: "1px solid #1A1A1A" }}
                    onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#2A2A2A")}
                    onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#1A1A1A")}
                  >
                    <span
                      className={`inline-block size-2 shrink-0 rounded-full ${phaseColorClass(p.status?.phase)}`}
                      title={p.status?.phase ?? "Unknown"}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-foreground/90">
                      {p.metadata.name}
                    </span>
                    {restarts > 0 && (
                      <span
                        className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]"
                        style={{ background: "rgba(245,158,11,0.15)", color: "#F59E0B" }}
                        title={`${restarts} restart${restarts === 1 ? "" : "s"}`}
                      >
                        ↺{restarts}
                      </span>
                    )}
                    <span
                      className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                      style={{ background: "#141417", border: "1px solid #1A1A1A" }}
                    >
                      {podReady(p)}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
                      {podAge(p.metadata.creationTimestamp)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Manage section — mutations via ConfirmSheet */}
      <div
        className="flex items-center gap-2 border-t pt-3"
        style={{ borderColor: "#1A1A1A" }}
      >
        <span className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground mr-2">
          Manage
        </span>
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={onRestart}>
          <RefreshCw className="size-3" />
          Restart
        </Button>
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={onEdit}>
          <SlidersHorizontal className="size-3" />
          Edit config
        </Button>
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={onRollback}>
          <Undo2 className="size-3" />
          Rollback
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={onTogglePause}
        >
          {paused ? <Play className="size-3" /> : <Pause className="size-3" />}
          {paused ? "Resume" : "Pause"}
        </Button>
      </div>
    </div>
  );
}

/**
 * A defined request/limit cell for the container card — small uppercase label
 * with an icon, then `req → lim` in mono. Reads as a compact data readout.
 */
function ResourceCell({
  icon,
  label,
  req,
  lim,
}: {
  icon: ReactNode;
  label: string;
  req: string | null | undefined;
  lim: string | null | undefined;
}) {
  return (
    <div
      className="flex items-center gap-2 rounded px-2 py-1"
      style={{ background: "#050505", border: "1px solid #1A1A1A" }}
    >
      {icon}
      <span className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {label}
      </span>
      <span className="ml-auto font-mono text-[11px] text-foreground/90 tabular-nums">
        {req ?? "—"} <span className="text-muted-foreground">→</span> {lim ?? "—"}
      </span>
    </div>
  );
}
