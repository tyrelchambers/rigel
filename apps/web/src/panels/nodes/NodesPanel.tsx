import { useEffect, useMemo, useState } from "react";
import { Minus, RotateCcw, ChevronRight, ChevronDown } from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { handoffToChat } from "@/lib/chatHandoff";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { ActionButtonStrip } from "@/panels/components/ActionButtonStrip";
import { PanelHeader } from "@/panels/components/PanelHeader";
import { buildHandoffPrompt } from "@/panels/components/chatHandoffPrompts";
import { useNodeMetrics, useNodeDisk, type ActionBlock, type NodeDiskItem } from "@/lib/api";
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
  parseCpuCores,
  parseBytes,
  formatCoresValue,
  formatBytesValue,
  usageColor,
  matchesSearch,
  sortNodes,
} from "./nodeDisplay";

interface PodLite {
  spec?: { nodeName?: string };
}

export default function NodesPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);

  const [search, setSearch] = useState("");
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data: nodeMetricsData } = useNodeMetrics();
  const { data: nodeDiskData } = useNodeDisk();

  // Nodes are cluster-scoped; pods feed the per-node pod count.
  useEffect(() => {
    subscribe("nodes", "*");
    subscribe("pods", "*");
    return () => {
      unsubscribe("nodes", "*");
      unsubscribe("pods", "*");
    };
  }, []);

  const allNodes = useMemo(
    () => sortNodes(Object.values((resources["nodes"] ?? {}) as Record<string, Node>)),
    [resources],
  );

  // Pods scheduled per node (by spec.nodeName) → the "Pods" bar numerator.
  const podCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of Object.values((resources["pods"] ?? {}) as Record<string, PodLite>)) {
      const n = p.spec?.nodeName;
      if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    return counts;
  }, [resources]);

  // Disk usage keyed by node name (kubelet Summary API).
  const diskByNode = useMemo(() => {
    const map = new Map<string, NodeDiskItem>();
    for (const d of nodeDiskData?.items ?? []) map.set(d.name, d);
    return map;
  }, [nodeDiskData]);
  const filtered = useMemo(
    () => allNodes.filter((n) => matchesSearch(n, search)),
    [allNodes, search],
  );

  const total = allNodes.length;
  const shown = filtered.length;

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
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Nodes"
        subtitle="Cluster infrastructure"
        count={shown !== total && search.trim() ? shown : total}
        loading={isLoading}
      >
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search nodes…"
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

        {/* Node cards */}
        <div className="flex flex-col gap-2 px-3 py-2.5">
        {filtered.map((n) => {
          const k = key(n);
          const nodeMetrics = nodeMetricsData?.available
            ? nodeMetricsData.items.find((m) => m.name === n.metadata.name)
            : undefined;
          return (
            <NodeCard
              key={k}
              node={n}
              isOpen={expanded.has(k)}
              onToggle={() => toggleExpand(n)}
              metrics={nodeMetrics}
              disk={diskByNode.get(n.metadata.name)}
              podCount={podCounts.get(n.metadata.name) ?? 0}
              onErrors={() => handoffToChat(buildHandoffPrompt("node", n.metadata.name, undefined, "Errors"))}
              onLogs={() => handoffToChat(buildHandoffPrompt("node", n.metadata.name, undefined, "Logs"))}
              onExplain={() => handoffToChat(buildHandoffPrompt("node", n.metadata.name, undefined, "Explain"))}
              onCordon={() => cordon(n)}
              onUncordon={() => uncordon(n)}
              onDrain={() => drain(n)}
            />
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
// NodeCard — title row + CPU/Memory/Disk/Pods usage bars (mirrors NodesPanel.swift)
// ---------------------------------------------------------------------------

interface NodeCardProps {
  node: Node;
  isOpen: boolean;
  onToggle: () => void;
  metrics?: { cpu: number; memory: number };
  disk?: NodeDiskItem;
  podCount: number;
  onErrors: () => void;
  onLogs: () => void;
  onExplain: () => void;
  onCordon: () => void;
  onUncordon: () => void;
  onDrain: () => void;
}

function NodeCard({
  node,
  isOpen,
  onToggle,
  metrics,
  disk,
  podCount,
  onErrors,
  onLogs,
  onExplain,
  onCordon,
  onUncordon,
  onDrain,
}: NodeCardProps) {
  const ready = isReady(node);
  const nodeRole = role(node);
  const cordoned = isCordoned(node);

  // Capacity (from the Node object) and live usage (metrics-server / kubelet).
  const cpuCap = parseCpuCores(capacityValue(node, "cpu"));
  const memCap = parseBytes(capacityValue(node, "memory"));
  const maxPods = Number(capacityValue(node, "pods")) || 0;
  // Server normalizes node metric cpu to plain millicores and memory to "<n>Mi".
  const cpuUse = metrics ? Number(metrics.cpu) / 1000 : 0;
  const memUse = metrics ? parseBytes(String(metrics.memory)) : 0;
  const diskCap = disk?.capacityBytes ?? parseBytes(capacityValue(node, "ephemeral-storage"));
  const diskUse = disk?.usedBytes ?? 0;

  const cpuPct = cpuCap > 0 ? cpuUse / cpuCap : 0;
  const memPct = memCap > 0 ? memUse / memCap : 0;
  const diskPct = diskCap > 0 ? diskUse / diskCap : 0;
  const podsPct = maxPods > 0 ? podCount / maxPods : 0;

  return (
    <div className="rounded-lg" style={{ background: "#141417", border: "1px solid #1A1A1A" }}>
      <div className="flex cursor-pointer flex-col gap-2.5 px-3.5 py-3" onClick={onToggle}>
        {/* Title row */}
        <div className="flex items-center gap-2.5">
          {isOpen ? (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
          )}
          <span className="font-mono text-[13px] font-medium leading-none text-foreground">
            {node.metadata.name}
          </span>
          <RoleChip role={nodeRole} />
          {cordoned && (
            <span
              style={{
                fontFamily: "ui-monospace, monospace",
                fontSize: 9,
                fontWeight: 600,
                letterSpacing: 0.5,
                textTransform: "uppercase",
                color: "#F59E0B",
                background: "rgba(245, 158, 11, 0.12)",
                padding: "1px 5px",
                borderRadius: 4,
              }}
            >
              cordoned
            </span>
          )}
          <span className="flex-1" />
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontSize: 11,
              fontWeight: 600,
              color: ready ? "#10B981" : "#EF4444",
              background: ready ? "rgba(16, 185, 129, 0.12)" : "rgba(239, 68, 68, 0.12)",
              padding: "2px 8px",
              borderRadius: 100,
              whiteSpace: "nowrap",
            }}
          >
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: "50%",
                background: ready ? "#10B981" : "#EF4444",
              }}
            />
            {ready ? "Ready" : "NotReady"}
          </span>
          <ActionButtonStrip
            onErrors={(e) => { e.stopPropagation(); onErrors(); }}
            onLogs={(e) => { e.stopPropagation(); onLogs(); }}
            onExplain={(e) => { e.stopPropagation(); onExplain(); }}
            extra={[
              cordoned
                ? { label: "Uncordon", Icon: RotateCcw, onClick: (e: React.MouseEvent) => { e.stopPropagation(); onUncordon(); } }
                : { label: "Cordon", Icon: Minus, onClick: (e: React.MouseEvent) => { e.stopPropagation(); onCordon(); } },
              { label: "Drain", Icon: RotateCcw, onClick: (e) => { e.stopPropagation(); onDrain(); }, destructive: true },
            ]}
          />
        </div>

        {/* Metrics row — CPU · Memory · Disk · Pods */}
        <div className="flex gap-4" onClick={(e) => e.stopPropagation()}>
          <NodeUsageBar
            title="CPU"
            percent={cpuPct}
            primaryText={formatCoresValue(cpuUse)}
            secondaryText={`/ ${formatCoresValue(cpuCap)} cores`}
            hasMetrics={metrics !== undefined}
          />
          <NodeUsageBar
            title="Memory"
            percent={memPct}
            primaryText={formatBytesValue(memUse)}
            secondaryText={`/ ${formatBytesValue(memCap)}`}
            hasMetrics={metrics !== undefined}
          />
          <NodeUsageBar
            title="Disk"
            percent={diskPct}
            primaryText={formatBytesValue(diskUse)}
            secondaryText={`/ ${formatBytesValue(diskCap)}`}
            hasMetrics={disk !== undefined}
          />
          <NodeUsageBar
            title="Pods"
            percent={podsPct}
            primaryText={`${podCount}`}
            secondaryText={`/ ${maxPods} pods`}
            hasMetrics={maxPods > 0}
          />
        </div>
      </div>

      {isOpen && (
        <div className="border-t px-3.5 py-3" style={{ borderColor: "#1A1A1A" }}>
          <NodeDetail node={node} cpuUsedCores={metrics ? cpuUse : undefined} memUsedBytes={metrics ? memUse : undefined} disk={disk} />
        </div>
      )}
    </div>
  );
}

function RoleChip({ role: r }: { role: "control-plane" | "worker" }) {
  const color = r === "control-plane" ? "#A855F7" : "#A1A1AA";
  return (
    <span
      style={{
        fontFamily: "ui-monospace, monospace",
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: 0.5,
        textTransform: "uppercase",
        color,
        background: r === "control-plane" ? "rgba(168, 85, 247, 0.12)" : "rgba(255,255,255,0.06)",
        padding: "2px 6px",
        borderRadius: 4,
        whiteSpace: "nowrap",
      }}
      title={`Role: ${r}`}
    >
      {r}
    </span>
  );
}

/** A labeled usage bar (title, %, colored progress, used / total). */
function NodeUsageBar({
  title,
  percent,
  primaryText,
  secondaryText,
  hasMetrics,
}: {
  title: string;
  percent: number;
  primaryText: string;
  secondaryText: string;
  hasMetrics: boolean;
}) {
  const color = usageColor(percent, hasMetrics);
  const width = Math.max(0, Math.min(1, percent)) * 100;
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1">
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: 0.5,
            textTransform: "uppercase",
            color: "#6B6B73",
          }}
        >
          {title}
        </span>
        <span className="flex-1" />
        <span
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: 10,
            fontWeight: 500,
            color: hasMetrics ? color : "#6B6B73",
          }}
        >
          {hasMetrics ? `${Math.round(percent * 100)}%` : "—"}
        </span>
      </div>
      <div style={{ height: 6, borderRadius: 3, background: "#1A1A1A", marginTop: 4, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${width}%`, background: color, borderRadius: 3, transition: "width 0.4s ease" }} />
      </div>
      <div className="flex items-center gap-1" style={{ marginTop: 4 }}>
        <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, fontWeight: 500, color: "#FFFFFF" }}>
          {primaryText}
        </span>
        <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: "#6B6B73" }}>
          {secondaryText}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expanded detail: System Info, Network & Storage, Live Usage, Pressure
// ---------------------------------------------------------------------------

function NodeDetail({
  node,
  cpuUsedCores,
  memUsedBytes,
  disk,
}: {
  node: Node;
  cpuUsedCores?: number;
  memUsedBytes?: number;
  disk?: NodeDiskItem;
}) {
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

      {/* Live usage from metrics-server / kubelet (optional) */}
      {(cpuUsedCores !== undefined || memUsedBytes !== undefined || disk !== undefined) && (
        <div className="space-y-2">
          <h3 className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            Live Usage
          </h3>
          <dl className="space-y-1 text-xs">
            {cpuUsedCores !== undefined && (
              <Field label="CPU used" value={`${formatCoresValue(cpuUsedCores)} cores`} />
            )}
            {memUsedBytes !== undefined && (
              <Field label="Mem used" value={formatBytesValue(memUsedBytes)} />
            )}
            {disk !== undefined && (
              <Field label="Free disk" value={formatBytesValue(disk.availableBytes)} />
            )}
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
