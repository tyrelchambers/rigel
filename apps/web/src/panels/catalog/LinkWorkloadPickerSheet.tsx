import { useEffect, useMemo, useState } from "react";
import { Link2, Search } from "lucide-react";
import {
  type CatalogApp,
  type DeploymentLike,
  type StatefulSetLike,
  type DaemonSetLike,
} from "@helmsman/catalog";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import type { WorkloadKind } from "./updateTargets";
import {
  pickableWorkloads,
  groupWorkloadsByNamespace,
  type PickableWorkload,
} from "./linkPickerLogic";

/** What the picker resolves to and hands off to the confirm gate. */
export interface LinkSelection {
  appID: string;
  kind: WorkloadKind;
  name: string;
  namespace: string;
  /** Set only for multi-container workloads (becomes catalog-container). */
  container?: string;
}

interface LinkWorkloadPickerSheetProps {
  /** The catalog app being linked (its `id` becomes the catalog-app value). */
  app: CatalogApp;
  open: boolean;
  onClose: () => void;
  /** Called when the user resolves a workload (+container) → parent opens ConfirmSheet. */
  onPick: (selection: LinkSelection) => void;
}

// Cluster-wide watches the picker needs while open.
const WATCHES: Array<[string, string]> = [
  ["deployments", "*"],
  ["statefulsets", "*"],
  ["daemonsets", "*"],
];

const KIND_BADGE: Record<WorkloadKind, string> = {
  deployment: "deployment",
  statefulset: "statefulset",
  daemonset: "daemonset",
};

/**
 * LinkWorkloadPickerSheet — searchable, namespace-grouped list of
 * Deployments/StatefulSets/DaemonSets. Selecting a workload either hands off
 * immediately (single container) or advances to a container step (multi). Built
 * on the PurgePickerSheet pattern. Mirrors the Swift `LinkWorkloadPickerSheet`.
 * See docs/parity/catalog-link-workload.md §5.
 */
export function LinkWorkloadPickerSheet({
  app,
  open,
  onClose,
  onPick,
}: LinkWorkloadPickerSheetProps) {
  const [search, setSearch] = useState("");
  // When set, we're on the container step for this multi-container workload.
  const [containerStep, setContainerStep] = useState<PickableWorkload | null>(null);
  const resources = useCluster((s) => s.resources);

  // Subscribe to the cluster-wide workload watches while the picker is open.
  useEffect(() => {
    if (!open) return;
    for (const [kind, ns] of WATCHES) subscribe(kind, ns);
    return () => {
      for (const [kind, ns] of WATCHES) unsubscribe(kind, ns);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setSearch("");
      setContainerStep(null);
    }
  }, [open]);

  const deployments = useMemo(
    () => Object.values((resources["deployments"] ?? {}) as Record<string, DeploymentLike>),
    [resources],
  );
  const statefulSets = useMemo(
    () => Object.values((resources["statefulsets"] ?? {}) as Record<string, StatefulSetLike>),
    [resources],
  );
  const daemonSets = useMemo(
    () => Object.values((resources["daemonsets"] ?? {}) as Record<string, DaemonSetLike>),
    [resources],
  );

  const all = useMemo(
    () => pickableWorkloads(deployments, statefulSets, daemonSets),
    [deployments, statefulSets, daemonSets],
  );
  const groups = useMemo(() => groupWorkloadsByNamespace(all, search), [all, search]);

  const hasAny = all.length > 0;
  const hasMatches = groups.length > 0;

  function selectWorkload(w: PickableWorkload) {
    // Step 2 (container) only when the workload has >1 container.
    if (w.containers.length > 1) {
      setContainerStep(w);
      return;
    }
    // Single (or zero) container → omit catalog-container.
    onPick({ appID: app.id, kind: w.kind, name: w.name, namespace: w.namespace });
    onClose();
  }

  function selectContainer(w: PickableWorkload, container: string) {
    onPick({ appID: app.id, kind: w.kind, name: w.name, namespace: w.namespace, container });
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="p-0 gap-0 max-h-[85vh] overflow-hidden max-w-2xl">
        <div className="flex flex-col gap-0.5 p-4">
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="size-4" />
            {containerStep ? "Choose a container" : `Link a workload to ${app.name}`}
          </DialogTitle>
          <DialogDescription>
            {containerStep
              ? `Pick which container of ${containerStep.name} backs ${app.name}.`
              : "Pick the Deployment, StatefulSet, or DaemonSet that runs this app. The next step shows the exact kubectl command."}
          </DialogDescription>
        </div>

        {containerStep ? (
          // ─── Step 2: container picker (multi-container only) ───
          <div className="flex-1 overflow-y-auto px-4 pb-4">
            <div className="overflow-hidden rounded-md border">
              {containerStep.containers.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  onClick={() => selectContainer(containerStep, c.name)}
                  className="flex w-full flex-col items-start gap-0.5 border-b px-2.5 py-2 text-left last:border-b-0 hover:bg-muted/50"
                >
                  <span className="font-mono text-xs">{c.name}</span>
                  {c.image && (
                    <span className="font-mono text-[10px] text-muted-foreground">{c.image}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {/* Search */}
            <div className="px-4">
              <div className="flex items-center gap-2 rounded-md border bg-background px-2.5">
                <Search className="size-3.5 text-muted-foreground" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search workloads or namespaces…"
                  className="w-full bg-transparent py-1.5 text-sm outline-none"
                />
              </div>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto px-4 pb-4">
              {!hasAny ? (
                <p className="py-3 text-sm text-muted-foreground">No workloads</p>
              ) : !hasMatches ? (
                <p className="py-3 text-sm text-muted-foreground">No matches.</p>
              ) : (
                <div className="space-y-3">
                  {groups.map((g) => (
                    <div key={g.namespace}>
                      <div className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {g.namespace}
                      </div>
                      <div className="overflow-hidden rounded-md border">
                        {g.workloads.map((w) => (
                          <button
                            key={`${w.kind}/${w.namespace}/${w.name}`}
                            type="button"
                            onClick={() => selectWorkload(w)}
                            className="flex w-full items-center gap-2 border-b px-2.5 py-1.5 text-left last:border-b-0 hover:bg-muted/50"
                          >
                            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                              {KIND_BADGE[w.kind]}
                            </span>
                            <span className="font-mono text-xs">{w.name}</span>
                            {w.boundTo && w.boundTo !== app.id && (
                              <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                                bound to {w.boundTo}
                              </span>
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
