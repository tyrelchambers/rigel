import { useEffect, useMemo, useState } from "react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { useFocusRow } from "@/panels/components/useFocusRow";
import { handoffToChat } from "@/lib/chatHandoff";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { PanelHeader } from "@/panels/components/PanelHeader";
import { LoadingState } from "@/panels/components/LoadingState";
import { buildHandoffPrompt } from "@/panels/components/chatHandoffPrompts";
import type { ActionBlock } from "@/lib/api";
import { useGitSources } from "@/panels/gitops/gitApi";
import { DeploymentEditor } from "./DeploymentEditor";
import type { Deployment } from "./types";
import type { Pod } from "../pods/types";
import {
  desiredReplicas,
  matchesSearch,
  sortDeployments,
  namespaceOptions,
} from "./deploymentDisplay";
import { DeploymentRow } from "./DeploymentRow";
import { DeploymentScaleDialog } from "./DeploymentScaleDialog";
import { MoveToNamespaceDialog } from "./MoveToNamespaceDialog";

export default function DeploymentsPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);
  const [search, setSearch] = useState("");
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [scaleTarget, setScaleTarget] = useState<Deployment | null>(null);
  const [editTarget, setEditTarget] = useState<Deployment | null>(null);
  const [moveTarget, setMoveTarget] = useState<Deployment | null>(null);
  // Registered GitOps deployments (flattened across repos), for the per-deployment
  // "Link to GitHub" control.
  const { data: gitSources } = useGitSources();
  const linkTargets = useMemo(
    () => (gitSources ?? []).flatMap((r) => r.deployments.map((dep) => ({ repo: r.name, dep }))),
    [gitSources],
  );
  const [scaleValue, setScaleValue] = useState("1");

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
  // Known namespaces (for the Move-to-namespace suggestions) — from loaded
  // deployments + any namespaces in the store.
  const nsOptions = useMemo(
    () => namespaceOptions(allDeployments, resources["namespaces"] ?? {}),
    [allDeployments, resources],
  );
  const filtered = useMemo(
    () => allDeployments.filter((d) => matchesSearch(d, search)),
    [allDeployments, search],
  );

  // Cmd-K / related-resources focus: expand + scroll to a deployment.
  useFocusRow("deployment", allDeployments, key, (k) => setExpanded((prev) => new Set(prev).add(k)));

  // Drop a stale deployment focus request if we leave before it resolves.
  useEffect(() => {
    return () => {
      if (useCluster.getState().focusRequest?.kind === "deployment") {
        useCluster.getState().setFocusRequest(null);
      }
    };
  }, []);

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

  // --- Mutation action builders --------------------------------------------

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

  function openEdit(d: Deployment) {
    setEditTarget(d);
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

  // --- Chat handoff -------------------------------------------------------

  function askClaude(d: Deployment, topic: "Errors" | "Logs" | "Explain" | "Rollout") {
    handoffToChat(buildHandoffPrompt("deployment", d.metadata.name, d.metadata.namespace, topic));
  }

  const scaleN = Math.max(0, Math.min(50, Math.floor(Number(scaleValue) || 0)));

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
          return (
            <DeploymentRow
              key={k}
              d={d}
              k={k}
              allPods={allPods}
              isOpen={expanded.has(k)}
              linkTargets={linkTargets}
              askClaude={askClaude}
              restart={restart}
              openScale={openScale}
              openEdit={openEdit}
              rollback={rollback}
              togglePause={togglePause}
              toggleExpand={toggleExpand}
              setPendingAction={setPendingAction}
              setMoveTarget={setMoveTarget}
            />
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

      {/* Scale prompt */}
      <DeploymentScaleDialog
        target={scaleTarget}
        value={scaleValue}
        onValueChange={setScaleValue}
        onConfirm={confirmScale}
        onClose={() => setScaleTarget(null)}
        scaleN={scaleN}
      />

      <ConfirmSheet
        action={pendingAction}
        open={!!pendingAction}
        onClose={() => setPendingAction(null)}
      />

      <DeploymentEditor
        target={editTarget}
        open={!!editTarget}
        onClose={() => setEditTarget(null)}
      />

      {moveTarget && (
        <MoveToNamespaceDialog
          deployment={moveTarget}
          namespaces={nsOptions}
          onClose={() => setMoveTarget(null)}
        />
      )}
    </div>
  );
}
