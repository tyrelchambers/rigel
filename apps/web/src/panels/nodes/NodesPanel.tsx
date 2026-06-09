import { Fragment, useEffect, useMemo, useState } from "react";
import { LoaderCircle, ChevronRight, ChevronDown, MoreHorizontal } from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import type { ActionBlock } from "@/lib/api";
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

  // Nodes are cluster-scoped: subscribe with namespace "*" (no namespace filter).
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
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Nodes</h1>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground">
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
          className="ml-auto w-64 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      {/* Error banner */}
      {error && (
        <pre className="rounded-md bg-destructive/10 px-3 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
          {error}
        </pre>
      )}

      {/* Table */}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-6" />
            <TableHead>Name</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Role</TableHead>
            <TableHead />
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((n) => {
            const k = key(n);
            const isOpen = expanded.has(k);
            const ready = isReady(n);
            const nodeRole = role(n);
            const cordoned = isCordoned(n);
            return (
              <Fragment key={k}>
                <TableRow>
                  <TableCell className="align-top">
                    <button
                      type="button"
                      onClick={() => toggleExpand(n)}
                      aria-label={isOpen ? "Collapse" : "Expand"}
                      aria-expanded={isOpen}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                    </button>
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => toggleExpand(n)}
                      className="font-mono hover:underline"
                    >
                      {n.metadata.name}
                    </button>
                  </TableCell>
                  <TableCell>
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                        ready
                          ? "bg-green-500/15 text-green-600 dark:text-green-400"
                          : "bg-red-500/15 text-red-600 dark:text-red-400"
                      }`}
                    >
                      {ready ? "Ready" : "NotReady"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-mono uppercase ${
                        nodeRole === "control-plane"
                          ? "bg-primary/10 text-primary"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {nodeRole === "control-plane" ? "CONTROL-PLANE" : "WORKER"}
                    </span>
                  </TableCell>
                  <TableCell>
                    {cordoned && (
                      <span className="inline-block rounded-full bg-yellow-500/15 px-2 py-0.5 text-xs font-mono uppercase text-yellow-600 dark:text-yellow-400">
                        CORDONED
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={<Button variant="ghost" size="icon-sm" aria-label="Node actions" title="Actions" />}
                      >
                        <MoreHorizontal />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        {!cordoned && (
                          <DropdownMenuItem onClick={() => cordon(n)}>Cordon node</DropdownMenuItem>
                        )}
                        {cordoned && (
                          <DropdownMenuItem onClick={() => uncordon(n)}>Uncordon node</DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => drain(n)}
                        >
                          Drain node…
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem disabled>View YAML… (soon)</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>

                {isOpen && (
                  <TableRow>
                    <TableCell colSpan={6} className="bg-muted/30">
                      <NodeDetail node={n} />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>

      {/* Empty / filtered-to-zero states */}
      {!isLoading && allNodes.length === 0 && (
        <p className="px-2 py-4 text-sm text-muted-foreground">No nodes found</p>
      )}
      {!isLoading && allNodes.length > 0 && filtered.length === 0 && (
        <p className="px-2 py-4 text-sm text-muted-foreground">No nodes match search</p>
      )}

      <ConfirmSheet
        action={pendingAction}
        open={!!pendingAction}
        onClose={() => setPendingAction(null)}
      />
    </div>
  );
}

/** Expanded detail block for one node: System Info, Network & Storage, Pressure. */
function NodeDetail({ node }: { node: Node }) {
  const info = node.status?.nodeInfo;
  const pressure = pressureConditions(node);
  return (
    <div className="space-y-3 px-2 py-3">
      <div className="grid gap-4 md:grid-cols-2">
        {/* System Info */}
        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
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

        {/* Network & Storage (capacity only — no usage metrics) */}
        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
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

      {/* Pressure conditions — only when active non-Ready conditions exist */}
      {pressure.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-yellow-600 dark:text-yellow-400">
            Pressure
          </h3>
          <ul className="space-y-1">
            {pressure.map((c) => (
              <li key={c.type} className="flex items-start gap-2 text-xs">
                <span className="mt-1 inline-block size-2 shrink-0 rounded-full bg-yellow-500" />
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
