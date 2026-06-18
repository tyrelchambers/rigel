// Pick a workload to link to a deployment (lists those not already on it).
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { GitBranch } from "lucide-react";
import type { ActionBlock } from "@/lib/api";
import type { Deployment } from "@/panels/deployments/types";
import { buildLinkAction, linkedSourceName, type WorkloadRef } from "./linkSource";
import type { DeploymentRef } from "./gitopsLogic";

export function LinkWorkloadDialog({
  target,
  workloads,
  onPick,
  onClose,
}: {
  target: DeploymentRef;
  workloads: Deployment[];
  onPick: (a: ActionBlock) => void;
  onClose: () => void;
}) {
  const candidates = workloads
    .filter((w) => linkedSourceName(w) !== target.dep.name)
    .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Link a workload to {target.dep.name}</DialogTitle>
          <DialogDescription>The workload is tagged with this deployment so the AI has context and can open fix-PRs.</DialogDescription>
        </DialogHeader>
        <div className="max-h-80 overflow-auto py-1">
          {candidates.length === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-muted-foreground">No workloads available to link.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {candidates.map((w) => {
                const ref: WorkloadRef = { name: w.metadata.name, namespace: w.metadata.namespace ?? "default", kind: "deployment" };
                const already = linkedSourceName(w);
                return (
                  <li key={`${ref.namespace}/${ref.name}`}>
                    <button
                      type="button"
                      onClick={() => onPick(buildLinkAction(ref, target.dep))}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-white/[0.04]"
                    >
                      <GitBranch className="size-3.5 shrink-0" style={{ color: "var(--accent-primary)" }} />
                      <span className="font-mono">{ref.name}</span>
                      <span className="text-xs text-muted-foreground">{ref.namespace}</span>
                      {already && <span className="ml-auto text-[10px] text-muted-foreground">re-point from {already}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
