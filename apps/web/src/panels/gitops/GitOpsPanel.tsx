// GitOps — deploy manifests from a GitHub repo. A source is ONE repo that owns a
// shared token/branch and a list of independently-syncable DEPLOYMENTS (manifest
// dirs). Each deployment has its own "Sync now": the server clones the repo, shows
// a kubectl diff preview, and applies on confirm. The GitHub PAT is managed in the
// Accounts panel. Manual-trigger only (no polling/webhooks).
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { PanelHeader } from "@/panels/components/PanelHeader";
import { Plus, FolderGit2 } from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import type { ActionBlock } from "@/lib/api";
import type { Deployment } from "@/panels/deployments/types";
import {
  useGitSources,
  useDeleteSource,
  type GitSource,
} from "./gitApi";
import { buildUnlinkAction } from "./linkSource";
import { groupLinkedByDeployment, type DeploymentRef } from "./gitopsLogic";
import { RepoCard } from "./RepoCard";
import { AddSourceDialog } from "./AddSourceDialog";
import { AddDeploymentDialog } from "./AddDeploymentDialog";
import { SyncDialog } from "./SyncDialog";
import { LinkWorkloadDialog } from "./GitOpsLinkWorkloadDialog";

export default function GitOpsPanel() {
  const { data: sources, isLoading } = useGitSources();
  const [addOpen, setAddOpen] = useState(false);
  const [addingTo, setAddingTo] = useState<GitSource | null>(null);
  const [syncing, setSyncing] = useState<DeploymentRef | null>(null);
  const [linking, setLinking] = useState<DeploymentRef | null>(null);
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);
  const del = useDeleteSource();

  // Workloads (for the per-deployment "linked workloads" view + link picker).
  const namespaceFilter = useCluster((s) => s.namespaceFilter);
  const resources = useCluster((s) => s.resources);
  useEffect(() => {
    const ns = namespaceFilter ?? "*";
    subscribe("deployments", ns);
    return () => unsubscribe("deployments", ns);
  }, [namespaceFilter]);
  const workloads = useMemo(
    () => Object.values((resources["deployments"] ?? {}) as Record<string, Deployment>),
    [resources],
  );
  /** deploymentName → linked workloads (provenance annotation = deployment name). */
  const linkedByDeployment = useMemo(() => groupLinkedByDeployment(workloads), [workloads]);

  const repoCount = sources?.length;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <PanelHeader title="GitOps" subtitle="Deploy manifests from a Git repo" count={repoCount} loading={isLoading}>
        <Button size="sm" className="gap-1.5" onClick={() => setAddOpen(true)}>
          <Plus className="size-3.5" /> Add repo
        </Button>
      </PanelHeader>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        {sources && sources.length === 0 && (
          <div style={{ textAlign: "center", color: "var(--fg-tertiary)", padding: "48px 0", fontSize: 13 }}>
            <FolderGit2 className="mx-auto mb-3 size-8 opacity-50" />
            No Git repos yet. Add a repo to deploy its manifests.
          </div>
        )}
        {sources?.map((s) => (
          <RepoCard
            key={s.name}
            source={s}
            linkedByDeployment={linkedByDeployment}
            onAddDeployment={() => setAddingTo(s)}
            onSync={(dep) => setSyncing({ repo: s, dep })}
            onLink={(dep) => setLinking({ repo: s, dep })}
            onUnlink={(w) => setPendingAction(buildUnlinkAction(w))}
            onDeleteRepo={() => del.mutate(s.name)}
            deleting={del.isPending && del.variables === s.name}
          />
        ))}
      </div>

      {addOpen && <AddSourceDialog onClose={() => setAddOpen(false)} />}
      {addingTo && <AddDeploymentDialog repo={addingTo} onClose={() => setAddingTo(null)} />}
      {syncing && <SyncDialog target={syncing} onClose={() => setSyncing(null)} />}
      {linking && (
        <LinkWorkloadDialog
          target={linking}
          workloads={workloads}
          onPick={(a) => { setPendingAction(a); setLinking(null); }}
          onClose={() => setLinking(null)}
        />
      )}
      <ConfirmSheet action={pendingAction} open={!!pendingAction} onClose={() => setPendingAction(null)} />
    </div>
  );
}
