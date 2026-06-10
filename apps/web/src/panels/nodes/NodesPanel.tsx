import { useEffect, useMemo, useState } from "react";
import { LoaderCircle, Minus, RotateCcw } from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { handoffToChat } from "@/lib/chatHandoff";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { ListRow } from "@/panels/components/ListRow";
import { TagPill } from "@/panels/components/TagPill";
import { StatusBadge } from "@/panels/components/StatusBadge";
import { ActionButtonStrip } from "@/panels/components/ActionButtonStrip";
import { buildHandoffPrompt } from "@/panels/components/chatHandoffPrompts";
import { useNodeMetrics, type ActionBlock } from "@/lib/api";
import type { Node } from "./types";
import {
  isReady,
  role,
  isCordoned,
  internalIP,
  pressureConditions,
  formatCpu,
  formatBytes,
  capacityValue,
  matchesSearch,
  sortNodes,
} from "./nodeDisplay";

export default function NodesPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);

  const [search, setSearch] = useState("");
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data: nodeMetricsData } = useNodeMetrics();

  // Nodes are cluster-scoped
  useEffect(() => {
    subscribe("nodes", "*");
    return () => unsubscribe("nodes", "*");
  }, []);

  const allNodes = useMemo(
    () => sortNodes(Object.values((resources["nodes"] ?? {}) as Record<string, Node>)),
    [resources],
  );
  const filtered = useMemo(
    () => allNodes.filter((n) => matchesSearch(n, search)),
    [allNodes, search],
  );

  const total = allNodes.length;
  const shown = filtered.length;
  const countLabel = search.trim() && shown !== total ? `${shown} / ${total}` : `${total}`;

  function key(n: Node): string {
    return n.metadata.uid || n.metadata.name;
  }

  function toggleExpand(n: Node) {
    const k = key(n);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  // --- Action builders (mirror docs/parity/nodes.md §4) ---------------------

  function cordon(n: Node) {
    setPendingAction({
      kind: "cordon",
      node: n.metadata.name,
      label: `Cordon node ${n.metadata.name}`,
    });
  }

  function uncordon(n: Node) {
    setPendingAction({
      kind: "uncordon",
      node: n.metadata.name,
      label: `Uncordon node ${n.metadata.name}`,
    });
  }

  function drain(n: Node) {
    setPendingAction({
      kind: "drain",
      node: n.metadata.name,
      destructive: true,
      label: `Drain node ${n.metadata.name}`,
    });
  }

  return (
    <div className="flex flex-col gap-0">
      {/* Header */}
      <div
        className="flex items-center gap-3 px-4 py-3"
        style={{ borderBottom: "1px solid #1A1A1A", background: "#141417" }}
      >
        <div className="flex flex-col gap-0">
          <span className="text-sm font-semibold leading-tight">Nodes</span>
          <span style={{ fontSize: 11, color: "#6B6B73" }}>Cluster infrastructure</span>
        </div>
        <span
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: 11,
            color: "#6B6B73",
            background: "#1A1A1A",
            padding: "2px 6px",
            borderRadius: 4,
          }}
        >
          {countLabel}
        </span>
        {isLoading && (
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-label="loading" />
        )}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search nodes…"
          className="ml-auto w-56 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      {/* Error banner */}
      {error && (
        <pre className="bg-destructive/10 px-4 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
          {error}
        </pre>
      )}

      {/* Row list */}
      <div className="flex flex-col gap-0.5 px-3 py-2">
        {filtered.map((n) => {
          const k = key(n);
          const isOpen = expanded.has(k);
          const ready = isReady(n);
          const nodeRole = role(n);
          const cordoned = isCordoned(n);
          const nodeMetrics = nodeMetricsData?.available
            ? nodeMetricsData.items.find((m) => m.name === n.metadata.name)
            : undefined;
          const cpuCap = formatCpu(capacityValue(n, "cpu"));
          const memCap = formatBytes(capacityValue(n, "memory"));

          return (
            <ListRow
              key={k}
              rowKey={k}
              isOpen={isOpen}
              onToggle={() => toggleExpand(n)}
              expandedContent={
                <NodeDetail
                  node={n}
                  nodeCpu={nodeMetrics?.cpu}
                  nodeMem={nodeMetrics?.memory}
                />
              }
            >
              {/* Name */}
              <button
                type="button"
                onClick={() => toggleExpand(n)}
                className="shrink-0 font-mono text-xs font-medium leading-none hover:underline text-foreground"
              >
                {n.metadata.name}
              </button>

              {/* Role — purple TagPill */}
              <TagPill
                label={nodeRole === "control-plane" ? "control-plane" : "worker"}
                title={`Role: ${nodeRole}`}
              />

              {/* Spacer */}
              <span className="flex-1" />

              {/* Capacity — dim */}
              {(cpuCap !== "—" || memCap !== "—") && (
                <span
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                    color: "#6B6B73",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  {cpuCap !== "—" && `cpu:${cpuCap}`}
                  {cpuCap !== "—" && memCap !== "—" && " "}
                  {memCap !== "—" && `mem:${memCap}`}
                </span>
              )}

              {/* Live usage from metrics-server */}
              {nodeMetrics !== undefined && (
                <span
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                    color: "#A1A1AA",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  {nodeMetrics.cpu !== undefined && `${nodeMetrics.cpu}m`}
                  {nodeMetrics.cpu !== undefined && nodeMetrics.memory !== undefined && " "}
                  {nodeMetrics.memory !== undefined && `${nodeMetrics.memory}Mi`}
                </span>
              )}

              {/* Cordoned badge */}
              {cordoned && (
                <StatusBadge label="Cordoned" variant="pending" />
              )}

              {/* Ready badge */}
              <StatusBadge
                label={ready ? "Ready" : "NotReady"}
                variant={ready ? "healthy" : "error"}
              />

              {/* Action strip — Errors / Logs / Explain + Cordon/Uncordon + Drain */}
              <ActionButtonStrip
                onErrors={(e) => {
                  e.stopPropagation();
                  handoffToChat(buildHandoffPrompt("node", n.metadata.name, undefined, "Errors"));
                }}
                onLogs={(e) => {
                  e.stopPropagation();
                  handoffToChat(buildHandoffPrompt("node", n.metadata.name, undefined, "Logs"));
                }}
                onExplain={(e) => {
                  e.stopPropagation();
                  handoffToChat(buildHandoffPrompt("node", n.metadata.name, undefined, "Explain"));
                }}
                extra={[
                  ...(cordoned
                    ? [
                        {
                          label: "Uncordon",
                          Icon: RotateCcw,
                          onClick: (e: React.MouseEvent) => { e.stopPropagation(); uncordon(n); },
                        },
                      ]
                    : [
                        {
                          label: "Cordon",
                          Icon: Minus,
                          onClick: (e: React.MouseEvent) => { e.stopPropagation(); cordon(n); },
                        },
                      ]),
                  {
                    label: "Drain",
                    Icon: RotateCcw,
                    onClick: (e) => { e.stopPropagation(); drain(n); },
                    destructive: true,
                  },
                ]}
              />
            </ListRow>
          );
        })}
      </div>

      {/* Empty / filtered-to-zero states */}
      {!isLoading && allNodes.length === 0 && (
        <p className="px-4 py-4 text-sm text-muted-foreground">No nodes found</p>
      )}
      {!isLoading && allNodes.length > 0 && filtered.length === 0 && (
        <p className="px-4 py-4 text-sm text-muted-foreground">No nodes match search</p>
      )}

      <ConfirmSheet
        action={pendingAction}
        open={!!pendingAction}
        onClose={() => setPendingAction(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expanded detail: System Info, Network & Storage, Live Usage, Pressure
// ---------------------------------------------------------------------------

function NodeDetail({ node, nodeCpu, nodeMem }: { node: Node; nodeCpu?: number; nodeMem?: number }) {
  const info = node.status?.nodeInfo;
  const pressure = pressureConditions(node);

  return (
    <div className="space-y-3">
      <div className="grid gap-4 md:grid-cols-2">
        {/* System Info */}
        <div className="space-y-2">
          <h3 className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            System Info
          </h3>
          <dl className="space-y-1 text-xs">
            <Field label="OS" value={info?.osImage} />
            <Field label="Kernel" value={info?.kernelVersion} />
            <Field label="Runtime" value={info?.containerRuntimeVersion} />
            <Field label="Kubelet" value={info?.kubeletVersion} />
            <Field label="Arch" value={info?.architecture} />
          </dl>
        </div>

        {/* Network & Storage */}
        <div className="space-y-2">
          <h3 className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            Network &amp; Storage
          </h3>
          <dl className="space-y-1 text-xs">
            <Field label="Internal IP" value={internalIP(node)} />
            <Field label="Pod CIDR" value={node.spec?.podCIDR} />
            <Field label="CPU" value={formatCpu(capacityValue(node, "cpu"))} />
            <Field label="Memory" value={formatBytes(capacityValue(node, "memory"))} />
            <Field label="Disk" value={formatBytes(capacityValue(node, "ephemeral-storage"))} />
            <Field label="Pods" value={capacityValue(node, "pods")} />
          </dl>
        </div>
      </div>

      {/* Live usage from metrics-server (optional) */}
      {(nodeCpu !== undefined || nodeMem !== undefined) && (
        <div className="space-y-2">
          <h3 className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            Live Usage
          </h3>
          <dl className="space-y-1 text-xs">
            {nodeCpu !== undefined && <Field label="CPU used" value={`${nodeCpu}m`} />}
            {nodeMem !== undefined && <Field label="Mem used" value={`${nodeMem}Mi`} />}
          </dl>
        </div>
      )}

      {/* Pressure conditions — only when active non-Ready conditions exist */}
      {pressure.length > 0 && (
        <div className="space-y-2">
          <h3
            className="text-[9px] font-semibold uppercase tracking-[0.05em]"
            style={{ color: "#F59E0B" }}
          >
            Pressure
          </h3>
          <ul className="space-y-1">
            {pressure.map((c) => (
              <li key={c.type} className="flex items-start gap-2 text-xs">
                <span
                  className="mt-1 inline-block size-2 shrink-0 rounded-full"
                  style={{ background: "#F59E0B" }}
                />
                <span className="font-mono font-medium">{c.type}</span>
                {c.message && <span className="text-muted-foreground">{c.message}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** One label/value detail row; renders "—" for missing values. */
function Field({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="font-mono break-all">{value && value.length > 0 ? value : "—"}</dd>
    </div>
  );
}
