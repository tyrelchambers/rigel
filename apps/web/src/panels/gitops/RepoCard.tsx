// One card per Git repo — its metadata, "Add deployment"/remove actions, and the
// list of independently-syncable deployment rows.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCodeBranch, faPlus, faTrashCan } from "@awesome.me/kit-6050953220/icons/classic/solid";
import type { Deployment } from "@/panels/deployments/types";
import { useDeleteDeployment, type GitSource, type GitDeployment } from "./gitApi";
import type { WorkloadRef } from "./linkSource";
import { DeploymentRow } from "./DeploymentRow";
import { GitOpsFileEditDialog } from "./GitOpsFileEditDialog";

export function RepoCard({
  source,
  linkedByDeployment,
  onAddDeployment,
  onSync,
  onLink,
  onUnlink,
  onDeleteRepo,
  deleting,
}: {
  source: GitSource;
  linkedByDeployment: Map<string, Deployment[]>;
  onAddDeployment: () => void;
  onSync: (dep: GitDeployment) => void;
  onLink: (dep: GitDeployment) => void;
  onUnlink: (w: WorkloadRef) => void;
  onDeleteRepo: () => void;
  deleting: boolean;
}) {
  const delDep = useDeleteDeployment();
  const [editingDep, setEditingDep] = useState<GitDeployment | null>(null);
  return (
    <div style={{ borderRadius: 12, border: "1px solid #26272B", background: "var(--surface-elevated)", padding: 14 }}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg" style={{ background: "var(--accent-primary)18", border: "1px solid #26272B" }}>
          <FontAwesomeIcon icon={faCodeBranch} className="size-4" style={{ color: "var(--accent-primary)" }} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-semibold">{source.name}</span>
          <span className="truncate font-mono text-xs" style={{ color: "var(--fg-tertiary)" }}>
            {source.repoURL} · {source.branch}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={onAddDeployment}>
            <FontAwesomeIcon icon={faPlus} className="size-3.5" /> Add deployment
          </Button>
          <Button size="sm" variant="ghost" onClick={onDeleteRepo} disabled={deleting} aria-label={`Remove ${source.name}`}>
            <FontAwesomeIcon icon={faTrashCan} className="size-3.5" style={{ color: "var(--status-failed)" }} />
          </Button>
        </div>
      </div>

      {/* One row per deployment — each independently syncable. */}
      <div className="mt-3 flex flex-col gap-2 border-t pt-2.5" style={{ borderColor: "var(--border-subtle)" }}>
        {source.deployments.length === 0 && (
          <span className="text-2xs" style={{ color: "var(--fg-tertiary)" }}>No deployments yet — add a manifest folder.</span>
        )}
        {source.deployments.map((dep) => (
          <DeploymentRow
            key={dep.name}
            dep={dep}
            linked={linkedByDeployment.get(dep.name) ?? []}
            onSync={() => onSync(dep)}
            onEditFiles={() => setEditingDep(dep)}
            onLink={() => onLink(dep)}
            onUnlink={onUnlink}
            onDelete={() => delDep.mutate({ repo: source.name, name: dep.name })}
            deleting={delDep.isPending && delDep.variables?.name === dep.name}
          />
        ))}
      </div>

      {editingDep && (
        <GitOpsFileEditDialog repo={source} dep={editingDep} onClose={() => setEditingDep(null)} />
      )}
    </div>
  );
}
