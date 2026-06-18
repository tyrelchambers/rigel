// One row per deployment within a RepoCard — its sync status, "Sync now", and the
// linked-workloads chips. Independently syncable.
import { Button } from "@/components/ui/button";
import { RefreshCw, Trash2, CheckCircle2, AlertTriangle, X, Plus, Boxes, FileCode } from "lucide-react";
import type { Deployment } from "@/panels/deployments/types";
import type { GitDeployment } from "./gitApi";
import type { WorkloadRef } from "./linkSource";

export function DeploymentRow({
  dep,
  linked,
  onSync,
  onEditFiles,
  onLink,
  onUnlink,
  onDelete,
  deleting,
}: {
  dep: GitDeployment;
  linked: Deployment[];
  onSync: () => void;
  onEditFiles: () => void;
  onLink: () => void;
  onUnlink: (w: WorkloadRef) => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  return (
    <div style={{ borderRadius: 10, border: "1px solid #26272B", background: "var(--surface-sunken)", padding: 10 }}>
      <div className="flex items-center gap-3">
        <Boxes className="size-3.5 shrink-0" style={{ color: "var(--accent-primary)" }} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[13px] font-medium">{dep.name}</span>
          <span className="truncate font-mono text-[11px]" style={{ color: "var(--fg-tertiary)" }}>{dep.path}</span>
          <SyncStatus dep={dep} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={onEditFiles}>
            <FileCode className="size-3.5" /> Edit files
          </Button>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={onSync}>
            <RefreshCw className="size-3.5" /> Sync now
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete} disabled={deleting} aria-label={`Remove ${dep.name}`}>
            <Trash2 className="size-3.5" style={{ color: "var(--status-failed)" }} />
          </Button>
        </div>
      </div>

      {/* Linked workloads — the AI uses these links for context + fix-PRs. */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t pt-2" style={{ borderColor: "var(--border-subtle)" }}>
        <span className="text-[11px]" style={{ color: "var(--fg-tertiary)" }}>Linked:</span>
        {linked.length === 0 && <span className="text-[11px]" style={{ color: "var(--fg-tertiary)" }}>none yet</span>}
        {linked.map((w) => (
          <span key={`${w.metadata.namespace}/${w.metadata.name}`} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-mono" style={{ background: "var(--surface-elevated)", border: "1px solid #26272B" }}>
            {w.metadata.name}
            <button
              type="button"
              aria-label={`Unlink ${w.metadata.name}`}
              onClick={() => onUnlink({ name: w.metadata.name, namespace: w.metadata.namespace ?? "default", kind: "deployment" })}
              className="opacity-60 hover:opacity-100"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <Button size="sm" variant="ghost" className="ml-auto h-6 gap-1 text-[11px]" onClick={onLink}>
          <Plus className="size-3" /> Link workload
        </Button>
      </div>
    </div>
  );
}

function SyncStatus({ dep }: { dep: GitDeployment }) {
  if (!dep.lastSyncedAt) {
    return <span className="text-[11px]" style={{ color: "var(--fg-tertiary)" }}>Never synced</span>;
  }
  const when = new Date(dep.lastSyncedAt).toLocaleString();
  const sha = dep.lastSyncedSha?.slice(0, 7);
  if (dep.lastStatus === "error") {
    return (
      <span className="flex items-center gap-1 text-[11px]" style={{ color: "var(--status-failed)" }}>
        <AlertTriangle className="size-3" /> Last sync failed · {when}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-[11px] text-emerald-400">
      <CheckCircle2 className="size-3" /> Synced {sha ? `@ ${sha}` : ""} · {when}
    </span>
  );
}
