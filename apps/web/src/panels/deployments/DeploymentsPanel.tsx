import { Fragment, useEffect, useMemo, useState } from "react";
import {
  LoaderCircle,
  RefreshCw,
  MoveVertical,
  Undo2,
  Pause,
  Play,
  MoreHorizontal,
  ChevronRight,
  ChevronDown,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { useNavigate } from "react-router";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe, sendChat } from "@/lib/ws";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import type { ActionBlock } from "@/lib/api";
import type { Deployment } from "./types";
import type { Pod } from "../pods/types";
import {
  relativeAge,
  readyText,
  readyColorClass,
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
  desiredReplicas,
  totalReplicas,
  matchesSearch,
  sortDeployments,
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
  const navigate = useNavigate();

  const [search, setSearch] = useState("");
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [scaleTarget, setScaleTarget] = useState<Deployment | null>(null);
  const [scaleValue, setScaleValue] = useState("1");

  // Subscribe to the deployments watch for the active namespace (or all). Pods
  // power the row color / error-state / child-pod detail, so subscribe to both.
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

  function toggleExpand(d: Deployment) {
    const k = key(d);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  // --- Action builders (mirror docs/parity/deployments.md §4) ---------------

  function restart(d: Deployment) {
    setPendingAction({
      kind: "restart",
      name: d.metadata.name,
      namespace: d.metadata.namespace ?? "default",
      label: `Restart deployment ${d.metadata.name}`,
    });
  }

  function rollback(d: Deployment) {
    setPendingAction({
      kind: "rollback",
      name: d.metadata.name,
      namespace: d.metadata.namespace ?? "default",
      label: `Rollback ${d.metadata.name} to previous version`,
    });
  }

  function togglePause(d: Deployment) {
    const paused = d.spec?.paused === true;
    setPendingAction({
      kind: paused ? "resume" : "pause",
      name: d.metadata.name,
      namespace: d.metadata.namespace ?? "default",
      label: paused
        ? `Resume rollout of ${d.metadata.name}`
        : `Pause rollout of ${d.metadata.name}`,
    });
  }

  function openScale(d: Deployment) {
    setScaleValue(String(desiredReplicas(d)));
    setScaleTarget(d);
  }

  function confirmScale() {
    if (!scaleTarget) return;
    const n = Math.max(0, Math.min(50, Math.floor(Number(scaleValue) || 0)));
    setPendingAction({
      kind: "scale",
      name: scaleTarget.metadata.name,
      namespace: scaleTarget.metadata.namespace ?? "default",
      replicas: n,
      label: `Scale ${scaleTarget.metadata.name} to ${n} replicas`,
    });
    setScaleTarget(null);
  }

  // Ask-Claude handoffs: prose-only, route to the chat panel.
  function askClaude(d: Deployment, topic: "Errors" | "Logs" | "Explain" | "Rollout") {
    const ns = d.metadata.namespace ?? "default";
    const prompts: Record<string, string> = {
      Errors: `Investigate errors on deployment ${d.metadata.name} in namespace ${ns}.`,
      Logs: `Show recent logs for deployment ${d.metadata.name} in namespace ${ns}.`,
      Explain: `Explain what deployment ${d.metadata.name} in namespace ${ns} does and its current state.`,
      Rollout: `Show the rollout status and recent history of deployment ${d.metadata.name} in namespace ${ns}.`,
    };
    sendChat(prompts[topic]);
    navigate("/chat");
  }

  const scaleN = Math.max(0, Math.min(50, Math.floor(Number(scaleValue) || 0)));

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Deployments</h1>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground">
          {filtered.length}
        </span>
        {isLoading && (
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-label="loading" />
        )}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search deployments…"
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
            <TableHead>Namespace</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Image</TableHead>
            <TableHead>Tag</TableHead>
            <TableHead>Ready</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead>Available</TableHead>
            <TableHead>Age</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((d) => {
            const k = key(d);
            const isOpen = expanded.has(k);
            const image = firstImage(d);
            const pods = childPods(d, allPods);
            const redeploying = isRedeploying(d, allPods);
            const total = totalReplicas(d);
            const updated = d.status?.updatedReplicas ?? 0;
            const paused = d.spec?.paused === true;
            return (
              <Fragment key={k}>
                <TableRow>
                  <TableCell className="align-top">
                    <button
                      type="button"
                      onClick={() => toggleExpand(d)}
                      aria-label={isOpen ? "Collapse" : "Expand"}
                      aria-expanded={isOpen}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      {isOpen ? (
                        <ChevronDown className="size-4" />
                      ) : (
                        <ChevronRight className="size-4" />
                      )}
                    </button>
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {d.metadata.namespace ?? "default"}
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => toggleExpand(d)}
                      className={`font-mono hover:underline ${statusColor(d, allPods)}`}
                    >
                      {d.metadata.name}
                    </button>
                    {/* Rollout churn chips */}
                    {redeploying && (
                      <span className="ml-2 inline-flex items-center gap-2 align-middle text-xs">
                        <span className="inline-flex items-center gap-0.5 text-green-600 dark:text-green-400">
                          <ArrowUp className="size-3" />
                          {updated}
                        </span>
                        <span className="inline-flex items-center gap-0.5 text-muted-foreground">
                          <ArrowDown className="size-3" />
                          {Math.max(0, total - updated)}
                        </span>
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground text-xs">
                    {imageRepo(image)}
                  </TableCell>
                  <TableCell>
                    <span className="inline-block rounded-full bg-primary/10 px-2 py-0.5 text-xs font-mono text-primary">
                      {imageTag(image)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-mono ${readyColorClass(d)}`}
                    >
                      {readyText(d)}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground">{updated}</TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {d.status?.availableReplicas ?? 0}
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {relativeAge(d.metadata.creationTimestamp)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="icon-sm" aria-label="Restart" title="Restart" onClick={() => restart(d)}>
                        <RefreshCw />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label="Scale" title="Scale" onClick={() => openScale(d)}>
                        <MoveVertical />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label="Rollback" title="Rollback" onClick={() => rollback(d)}>
                        <Undo2 />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={paused ? "Resume" : "Pause"}
                        title={paused ? "Resume" : "Pause"}
                        onClick={() => togglePause(d)}
                      >
                        {paused ? <Play /> : <Pause />}
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={<Button variant="ghost" size="icon-sm" aria-label="More actions" title="More" />}
                        >
                          <MoreHorizontal />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownMenuItem onClick={() => askClaude(d, "Errors")}>
                            Ask Claude: Errors
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => askClaude(d, "Logs")}>
                            Ask Claude: Logs
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => askClaude(d, "Explain")}>
                            Ask Claude: Explain
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => askClaude(d, "Rollout")}>
                            Ask Claude: Rollout
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem disabled>View YAML… (soon)</DropdownMenuItem>
                          <DropdownMenuItem disabled>Manage… (soon)</DropdownMenuItem>
                          <DropdownMenuItem disabled>Move to namespace… (soon)</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>

                {/* Rollout progress bar row */}
                {redeploying && (
                  <TableRow>
                    <TableCell colSpan={10} className="p-0">
                      <div className="h-0.5 w-full bg-muted">
                        <div
                          className="h-0.5 bg-green-500 transition-all"
                          style={{ width: `${Math.round(rolloutProgress(d) * 100)}%` }}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                )}

                {/* Expanded detail */}
                {isOpen && (
                  <TableRow>
                    <TableCell colSpan={10} className="bg-muted/30">
                      <DeploymentDetail deployment={d} pods={pods} />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>

      {/* Empty / filtered-to-zero states */}
      {!isLoading && allDeployments.length === 0 && (
        <p className="px-2 py-4 text-sm text-muted-foreground">No deployments found</p>
      )}
      {!isLoading && allDeployments.length > 0 && filtered.length === 0 && (
        <p className="px-2 py-4 text-sm text-muted-foreground">No deployments match search</p>
      )}

      {/* Scale prompt */}
      <Dialog open={!!scaleTarget} onOpenChange={(o) => { if (!o) setScaleTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Scale {scaleTarget?.metadata.name}</DialogTitle>
            <DialogDescription>Enter replica count (0–50).</DialogDescription>
          </DialogHeader>
          <input
            type="number"
            min={0}
            max={50}
            value={scaleValue}
            onChange={(e) => setScaleValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") confirmScale(); }}
            className="w-full rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
            aria-label="Replica count"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setScaleTarget(null)}>Cancel</Button>
            <Button onClick={confirmScale}>Scale to {scaleN}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmSheet
        action={pendingAction}
        open={!!pendingAction}
        onClose={() => setPendingAction(null)}
      />
    </div>
  );
}

/** Expanded SPEC + PODS detail blocks for one deployment. */
function DeploymentDetail({ deployment, pods }: { deployment: Deployment; pods: Pod[] }) {
  const containers = containerSummaries(deployment);
  const sortedPods = [...pods].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  return (
    <div className="grid gap-4 px-2 py-3 md:grid-cols-2">
      {/* SPEC block */}
      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Spec</h3>
        <dl className="space-y-1 text-xs">
          <div className="flex gap-2">
            <dt className="w-20 text-muted-foreground">Strategy</dt>
            <dd className="font-mono">{strategyDescription(deployment)}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-20 text-muted-foreground">Selector</dt>
            <dd className="font-mono">{selectorString(deployment)}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-20 text-muted-foreground">Created</dt>
            <dd className="font-mono">{relativeAge(deployment.metadata.creationTimestamp)} ago</dd>
          </div>
        </dl>
        <div className="space-y-2 pt-1">
          {containers.map((c) => (
            <div key={c.name} className="rounded-md border bg-background/50 p-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-mono font-medium text-primary">{c.name}</span>
                {c.ports.length > 0 && (
                  <span className="font-mono text-muted-foreground">
                    {c.ports.map((p) => `:${p}`).join(" ")}
                  </span>
                )}
              </div>
              <div className="font-mono text-muted-foreground break-all">{c.image}</div>
              <div className="font-mono text-muted-foreground">
                cpu req {c.cpuReq ?? "—"} / lim {c.cpuLim ?? "—"}
              </div>
              <div className="font-mono text-muted-foreground">
                mem req {c.memReq ?? "—"} / lim {c.memLim ?? "—"}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* PODS block */}
      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Pods ({sortedPods.length})
        </h3>
        {sortedPods.length === 0 ? (
          <p className="text-xs text-muted-foreground">No matching pods</p>
        ) : (
          <ul className="space-y-1">
            {sortedPods.map((p) => {
              const restarts = restartCount(p);
              return (
                <li key={p.metadata.uid || p.metadata.name} className="flex items-center gap-2 text-xs">
                  <span
                    className={`inline-block size-2 shrink-0 rounded-full ${phaseColorClass(p.status?.phase)}`}
                    title={p.status?.phase ?? "Unknown"}
                  />
                  <span className="font-mono text-muted-foreground truncate">{p.metadata.name}</span>
                  {restarts > 0 && (
                    <span className="rounded-full bg-amber-500/15 px-1.5 text-amber-600 dark:text-amber-400">
                      ×{restarts}
                    </span>
                  )}
                  <span className="ml-auto font-mono text-muted-foreground">{podReady(p)}</span>
                  <span className="font-mono text-muted-foreground">{podAge(p.metadata.creationTimestamp)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
