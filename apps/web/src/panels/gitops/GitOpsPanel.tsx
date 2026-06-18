// GitOps — deploy manifests from a GitHub repo. A source is ONE repo that owns a
// shared token/branch and a list of independently-syncable DEPLOYMENTS (manifest
// dirs). Each deployment has its own "Sync now": the server clones the repo, shows
// a kubectl diff preview, and applies on confirm. The GitHub PAT is managed in the
// Accounts panel. Manual-trigger only (no polling/webhooks).
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PanelHeader } from "@/panels/components/PanelHeader";
import { GitBranch, Plus, RefreshCw, Trash2, CheckCircle2, AlertTriangle, FolderGit2, X, Check, Folder, FileText, Boxes } from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import type { ActionBlock } from "@/lib/api";
import type { Deployment } from "@/panels/deployments/types";
import {
  useGitSources,
  useSaveSource,
  useDeleteSource,
  useSaveDeployment,
  useDeleteDeployment,
  useGitHubAccount,
  useConnectGitHub,
  useGitHubRepos,
  useRepoTree,
  syncDeployment,
  type GitSource,
  type GitDeployment,
  type GithubRepo,
  type SyncResult,
} from "./gitApi";
import { GITHUB_TOKEN_URL } from "./GitHubConnectionCard";
import { buildLinkAction, buildUnlinkAction, linkedSourceName, type WorkloadRef } from "./linkSource";

/** A deployment paired with its repo — the unit acted on by sync/link dialogs. */
interface DeploymentRef {
  repo: GitSource;
  dep: GitDeployment;
}

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
  const linkedByDeployment = useMemo(() => {
    const map = new Map<string, Deployment[]>();
    for (const w of workloads) {
      const dep = linkedSourceName(w);
      if (!dep) continue;
      const list = map.get(dep);
      if (list) list.push(w);
      else map.set(dep, [w]);
    }
    return map;
  }, [workloads]);

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

function RepoCard({
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
  return (
    <div style={{ borderRadius: 12, border: "1px solid #26272B", background: "var(--surface-elevated)", padding: 14 }}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg" style={{ background: "var(--accent-primary)18", border: "1px solid #26272B" }}>
          <GitBranch className="size-4" style={{ color: "var(--accent-primary)" }} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-semibold">{source.name}</span>
          <span className="truncate font-mono text-xs" style={{ color: "var(--fg-tertiary)" }}>
            {source.repoURL} · {source.branch}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={onAddDeployment}>
            <Plus className="size-3.5" /> Add deployment
          </Button>
          <Button size="sm" variant="ghost" onClick={onDeleteRepo} disabled={deleting} aria-label={`Remove ${source.name}`}>
            <Trash2 className="size-3.5" style={{ color: "var(--status-failed)" }} />
          </Button>
        </div>
      </div>

      {/* One row per deployment — each independently syncable. */}
      <div className="mt-3 flex flex-col gap-2 border-t pt-2.5" style={{ borderColor: "var(--border-subtle)" }}>
        {source.deployments.length === 0 && (
          <span className="text-[11px]" style={{ color: "var(--fg-tertiary)" }}>No deployments yet — add a manifest folder.</span>
        )}
        {source.deployments.map((dep) => (
          <DeploymentRow
            key={dep.name}
            dep={dep}
            linked={linkedByDeployment.get(dep.name) ?? []}
            onSync={() => onSync(dep)}
            onLink={() => onLink(dep)}
            onUnlink={onUnlink}
            onDelete={() => delDep.mutate({ repo: source.name, name: dep.name })}
            deleting={delDep.isPending && delDep.variables?.name === dep.name}
          />
        ))}
      </div>
    </div>
  );
}

function DeploymentRow({
  dep,
  linked,
  onSync,
  onLink,
  onUnlink,
  onDelete,
  deleting,
}: {
  dep: GitDeployment;
  linked: Deployment[];
  onSync: () => void;
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

/** Pick a workload to link to a deployment (lists those not already on it). */
function LinkWorkloadDialog({
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

/** Slug a repo's name part for the source name (matches server sanitizeSourceName). */
function repoToName(fullName: string): string {
  const repo = fullName.split("/").pop() ?? fullName;
  return slug(repo);
}

/** Lowercase DNS-ish slug, mirroring the server's sanitizeSourceName. */
function slug(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** A sensible default deployment name from a manifest path: the last meaningful
 *  segment, skipping generic dirs like k8s/deploy/manifests. */
const GENERIC_DIRS = new Set(["k8s", "kubernetes", "deploy", "deployment", "manifests", "manifest", "kustomize", "base", "overlays", "prod", "production"]);
function deriveDeployName(path: string, repoName: string): string {
  const segs = path.split("/").filter((s) => s && s !== ".");
  for (let i = segs.length - 1; i >= 0; i--) {
    if (!GENERIC_DIRS.has(segs[i]!.toLowerCase())) return slug(segs[i]!);
  }
  return slug(segs[segs.length - 1] ?? repoName);
}

/**
 * Add-repo wizard. Step 1 (only when GitHub isn't connected): ask for the PAT.
 * Step 2: pick a repo, set name/branch, and queue one or more manifest folders as
 * deployments before saving.
 */
function AddSourceDialog({ onClose }: { onClose: () => void }) {
  const { data: account, isLoading: acctLoading } = useGitHubAccount();
  const connected = account?.connected === true;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        {acctLoading ? (
          <>
            <DialogHeader>
              <DialogTitle>Add Git repo</DialogTitle>
              <DialogDescription>Checking your GitHub connection…</DialogDescription>
            </DialogHeader>
            <div className="py-2"><FormSkeleton /></div>
          </>
        ) : connected ? (
          <PickRepoStep onClose={onClose} />
        ) : (
          <ConnectStep onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Step 1 — ask for the PAT (with a create-token link). On success the parent
 *  re-renders into PickRepoStep because `connected` flips. */
function ConnectStep({ onClose }: { onClose: () => void }) {
  const connect = useConnectGitHub();
  const [token, setToken] = useState("");

  async function handleConnect() {
    try {
      await connect.mutateAsync(token);
    } catch {
      /* error shown below */
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Connect GitHub</DialogTitle>
        <DialogDescription>Helmsman needs a personal access token to list your repos and open PRs. It's stored as a cluster Secret.</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-3 py-1">
        <a href={GITHUB_TOKEN_URL} target="_blank" rel="noreferrer" className="text-xs hover:underline" style={{ color: "var(--accent-primary)" }}>
          Create a personal access token (classic, “repo” scope)
        </a>
        <input
          type="password"
          value={token}
          placeholder="ghp_…"
          autoFocus
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && token) handleConnect(); }}
          spellCheck={false}
          style={{ padding: "8px 10px", borderRadius: 8, background: "#08080A", border: "1px solid #26272B", color: "var(--fg-primary)", fontSize: 13, fontFamily: "ui-monospace, monospace", outline: "none" }}
        />
        {connect.isError && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{connect.error.message}</p>}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={connect.isPending}>Cancel</Button>
        <Button onClick={handleConnect} disabled={!token || connect.isPending}>{connect.isPending ? "Connecting…" : "Connect & continue"}</Button>
      </DialogFooter>
    </>
  );
}

/** Step 2 — pick a repo, set name/branch, queue ≥1 deployment, then save. */
function PickRepoStep({ onClose }: { onClose: () => void }) {
  const save = useSaveSource();
  const { data: repos, isLoading, isError, error } = useGitHubRepos(true);
  const [fullName, setFullName] = useState("");
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [deployments, setDeployments] = useState<{ name: string; path: string }[]>([]);

  const selected = useMemo<GithubRepo | undefined>(() => repos?.find((r) => r.fullName === fullName), [repos, fullName]);

  function pickRepo(fn: string) {
    setFullName(fn);
    const r = repos?.find((x) => x.fullName === fn);
    if (r) {
      setName(repoToName(r.fullName));
      setBranch(r.defaultBranch);
      setDeployments([]);
    }
  }

  const canSave = !!selected && name.trim() !== "" && deployments.length > 0 && !save.isPending;

  async function handleSave() {
    if (!selected) return;
    try {
      await save.mutateAsync({ name, repoURL: selected.cloneURL, branch: branch || selected.defaultBranch, deployments });
      onClose();
    } catch {
      /* error shown below */
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add Git repo</DialogTitle>
        <DialogDescription>Pick a repo, then add one or more manifest folders to deploy.</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-3 py-1">
        {isLoading ? (
          <FormSkeleton />
        ) : (
          <>
            <RepoCombobox repos={repos ?? []} value={fullName} onChange={pickRepo} error={isError ? error.message : null} />
            {selected && (
              <>
                <div className="flex gap-3">
                  <Field label="Repo name" value={name} onChange={setName} placeholder="my-app" />
                  <Field label="Branch" value={branch} onChange={setBranch} placeholder={selected.defaultBranch} />
                </div>
                <DeploymentQueue
                  repo={selected.fullName}
                  repoName={name}
                  branch={branch || selected.defaultBranch}
                  deployments={deployments}
                  onChange={setDeployments}
                />
              </>
            )}
          </>
        )}
        {save.isError && (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{save.error.message}</p>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button>
        <Button onClick={handleSave} disabled={!canSave}>{save.isPending ? "Saving…" : `Add repo${deployments.length ? ` (${deployments.length})` : ""}`}</Button>
      </DialogFooter>
    </>
  );
}

/** Browse the repo and queue manifest folders as named deployments (add-repo wizard). */
function DeploymentQueue({
  repo,
  repoName,
  branch,
  deployments,
  onChange,
}: {
  repo: string;
  repoName: string;
  branch: string;
  deployments: { name: string; path: string }[];
  onChange: (next: { name: string; path: string }[]) => void;
}) {
  const [path, setPath] = useState(".");

  function addCurrent() {
    if (deployments.some((d) => d.path === path)) return;
    onChange([...deployments, { name: deriveDeployName(path, repoName), path }]);
  }

  return (
    <div className="flex flex-col gap-2">
      <RepoPathBrowser repo={repo} branch={branch} value={path} onChange={setPath} />
      <Button size="sm" variant="outline" className="gap-1.5 self-start" onClick={addCurrent} disabled={deployments.some((d) => d.path === path)}>
        <Plus className="size-3.5" /> Add this folder
      </Button>
      {deployments.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {deployments.map((d, i) => (
            <li key={d.path} className="flex items-center gap-2 rounded-lg px-2 py-1.5" style={{ background: "#08080A", border: "1px solid #26272B" }}>
              <Boxes className="size-3.5 shrink-0" style={{ color: "var(--accent-primary)" }} />
              <input
                value={d.name}
                onChange={(e) => onChange(deployments.map((x, xi) => (xi === i ? { ...x, name: e.target.value } : x)))}
                spellCheck={false}
                style={{ width: 140, background: "transparent", border: "none", color: "var(--fg-primary)", fontSize: 12.5, fontFamily: "ui-monospace, monospace", outline: "none" }}
              />
              <span className="truncate font-mono text-[11px]" style={{ color: "var(--fg-tertiary)" }}>{d.path}</span>
              <button type="button" aria-label={`Remove ${d.name}`} className="ml-auto opacity-60 hover:opacity-100" onClick={() => onChange(deployments.filter((_, xi) => xi !== i))}>
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Add a single deployment to an existing repo (the card's "Add deployment"). */
function AddDeploymentDialog({ repo, onClose }: { repo: GitSource; onClose: () => void }) {
  const save = useSaveDeployment();
  const repoFullName = repo.repoURL.replace(/\.git$/, "").replace(/^https?:\/\/github\.com\//, "");
  const [path, setPath] = useState(".");
  const [name, setName] = useState("");

  // Keep the name in sync with the browsed folder until the user edits it.
  const [edited, setEdited] = useState(false);
  useEffect(() => {
    if (!edited) setName(deriveDeployName(path, repo.name));
  }, [path, edited, repo.name]);

  const canSave = name.trim() !== "" && !save.isPending;

  async function handleSave() {
    try {
      await save.mutateAsync({ repo: repo.name, name, path });
      onClose();
    } catch {
      /* error shown below */
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add deployment to {repo.name}</DialogTitle>
          <DialogDescription>Pick a manifest folder in {repo.repoURL} · {repo.branch}.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-1">
          <Field label="Deployment name" value={name} onChange={(v) => { setEdited(true); setName(v); }} placeholder="marketing" />
          <RepoPathBrowser repo={repoFullName} branch={repo.branch} value={path} onChange={setPath} />
          {save.isError && (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{save.error.message}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button onClick={handleSave} disabled={!canSave}>{save.isPending ? "Saving…" : "Add deployment"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Searchable repo list — type to filter, click to pick (client-side over the
 *  already-fetched repos). */
function RepoCombobox({ repos, value, onChange, error }: { repos: GithubRepo[]; value: string; onChange: (fullName: string) => void; error: string | null }) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle ? repos.filter((r) => r.fullName.toLowerCase().includes(needle)) : repos;
    return list.slice(0, 60);
  }, [repos, q]);

  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium" style={{ color: "var(--fg-secondary)" }}>Repository</span>
      <input
        type="text"
        value={q}
        placeholder="Search your repositories…"
        onChange={(e) => setQ(e.target.value)}
        autoFocus
        spellCheck={false}
        style={{ padding: "8px 10px", borderRadius: 8, background: "#08080A", border: "1px solid #26272B", color: "var(--fg-primary)", fontSize: 13, outline: "none" }}
      />
      {error ? (
        <span className="text-xs text-destructive">{error}</span>
      ) : (
        <ul className="max-h-44 overflow-auto rounded-lg" style={{ background: "#08080A", border: "1px solid #26272B" }}>
          {filtered.length === 0 && <li className="px-2.5 py-2 text-xs text-muted-foreground">No matching repositories.</li>}
          {filtered.map((r) => {
            const sel = r.fullName === value;
            return (
              <li key={r.fullName}>
                <button
                  type="button"
                  onClick={() => onChange(r.fullName)}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-[13px] hover:bg-white/[0.04]"
                  style={sel ? { background: "var(--accent-primary)22" } : undefined}
                >
                  {sel ? <Check className="size-3.5 shrink-0" style={{ color: "var(--accent-primary)" }} /> : <span className="w-3.5 shrink-0" />}
                  <span className="truncate">{r.fullName}</span>
                  {r.private && <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">private</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </label>
  );
}

/** Lazy 1-level folder browser — click a folder to descend, breadcrumb to go up.
 *  The current folder IS the chosen manifest path ("." = repo root). */
function RepoPathBrowser({ repo, branch, value, onChange }: { repo: string; branch: string; value: string; onChange: (path: string) => void }) {
  const apiPath = value === "." ? "" : value;
  const { data: entries, isLoading, isError } = useRepoTree(repo, branch, apiPath, true);
  const segments = apiPath ? apiPath.split("/") : [];
  const dirs = (entries ?? []).filter((e) => e.type === "dir");
  const files = (entries ?? []).filter((e) => e.type === "file");

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium" style={{ color: "var(--fg-secondary)" }}>Manifest folder</span>
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <button type="button" onClick={() => onChange(".")} className="hover:underline" style={{ color: apiPath === "" ? "var(--fg-primary)" : "var(--accent-primary)" }}>root</button>
        {segments.map((seg, i) => {
          const p = segments.slice(0, i + 1).join("/");
          const isLast = i === segments.length - 1;
          return (
            <span key={p} className="flex items-center gap-1">
              <span style={{ color: "var(--fg-tertiary)" }}>/</span>
              <button type="button" onClick={() => onChange(p)} className="font-mono hover:underline" style={{ color: isLast ? "var(--fg-primary)" : "var(--accent-primary)" }}>{seg}</button>
            </span>
          );
        })}
      </div>
      <div className="max-h-44 overflow-auto rounded-lg" style={{ background: "#08080A", border: "1px solid #26272B" }}>
        {isLoading && <div className="px-2.5 py-2 text-xs text-muted-foreground">Loading…</div>}
        {isError && <div className="px-2.5 py-2 text-xs text-destructive">Couldn't read this folder.</div>}
        {!isLoading && !isError && dirs.length === 0 && files.length === 0 && (
          <div className="px-2.5 py-2 text-xs text-muted-foreground">Empty folder.</div>
        )}
        {dirs.map((d) => (
          <button key={d.path} type="button" onClick={() => onChange(d.path)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-white/[0.04]">
            <Folder className="size-3.5 shrink-0" style={{ color: "var(--accent-primary)" }} />
            <span className="font-mono">{d.name}/</span>
          </button>
        ))}
        {files.map((f) => (
          <div key={f.path} className="flex items-center gap-2 px-2.5 py-1.5 text-[13px]" style={{ color: "var(--fg-tertiary)" }}>
            <FileText className="size-3.5 shrink-0" />
            <span className="font-mono">{f.name}</span>
          </div>
        ))}
      </div>
      <span className="text-[11px]" style={{ color: "var(--fg-tertiary)" }}>
        Deploys from <span className="font-mono text-foreground/90">{value}</span>
        {files.length > 0 ? ` · ${files.length} file${files.length === 1 ? "" : "s"} here` : ""}
      </span>
    </div>
  );
}

/** Pulsing placeholders shown while the repo list loads. */
function FormSkeleton() {
  const bar = (w: string, h = 34) => (
    <div className="animate-pulse rounded-md" style={{ width: w, height: h, background: "rgba(255,255,255,0.10)" }} />
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        {bar("70px", 12)}
        {bar("100%")}
      </div>
      <div className="flex gap-3">
        {bar("100%")}
        {bar("100%")}
        {bar("100%")}
      </div>
    </div>
  );
}

/** Two-step guarded sync: load the kubectl diff preview, then apply on confirm. */
function SyncDialog({ target, onClose }: { target: DeploymentRef; onClose: () => void }) {
  const { repo, dep } = target;
  const qc = useQueryClient();
  const [phase, setPhase] = useState<"diffing" | "preview" | "applying" | "done">("diffing");
  const [diff, setDiff] = useState<SyncResult | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Kick off the diff once on mount.
  useEffect(() => {
    let cancelled = false;
    syncDeployment(repo.name, dep.name, true)
      .then((r) => { if (!cancelled) { setDiff(r); setPhase("preview"); } })
      .catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setPhase("preview"); } });
    return () => { cancelled = true; };
  }, [repo.name, dep.name]);

  async function handleApply() {
    setPhase("applying");
    try {
      const r = await syncDeployment(repo.name, dep.name, false);
      setResult(r);
      setPhase("done");
      qc.invalidateQueries({ queryKey: ["git-sources"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("done");
    }
  }

  const diffText = diff ? (diff.stdout || diff.stderr || "No differences — cluster matches the repo.") : "";

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Sync {dep.name}</DialogTitle>
          <DialogDescription>{repo.repoURL} · {repo.branch} · {dep.path}</DialogDescription>
        </DialogHeader>

        <div className="py-1">
          {phase === "diffing" && <p className="text-sm text-muted-foreground">Cloning repo and computing diff…</p>}
          {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive whitespace-pre-wrap">{error}</p>}
          {(phase === "preview" || phase === "applying") && !error && (
            <pre className="max-h-80 overflow-auto rounded-lg p-3 text-xs font-mono whitespace-pre-wrap" style={{ background: "#08080A", border: "1px solid #26272B" }}>
              {diffText}
            </pre>
          )}
          {phase === "done" && result && (
            result.code === 0 ? (
              <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-400"><CheckCircle2 className="size-4" /> Applied{result.sha ? ` @ ${result.sha.slice(0, 7)}` : ""}.</p>
            ) : (
              <pre className="max-h-80 overflow-auto rounded-lg bg-destructive/10 p-3 text-xs font-mono text-destructive whitespace-pre-wrap">{result.stderr || result.stdout}</pre>
            )
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{phase === "done" ? "Close" : "Cancel"}</Button>
          {phase !== "done" && (
            <Button onClick={handleApply} disabled={phase !== "preview" || !!error}>
              {phase === "applying" ? "Applying…" : "Apply sync"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="flex flex-1 flex-col gap-1">
      <span className="text-xs font-medium" style={{ color: "var(--fg-secondary)" }}>{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        style={{
          padding: "8px 10px",
          borderRadius: 8,
          background: "#08080A",
          border: "1px solid #26272B",
          color: "var(--fg-primary)",
          fontSize: 13,
          fontFamily: type === "password" || label.includes("URL") || label.includes("path") ? "ui-monospace, monospace" : undefined,
          outline: "none",
        }}
      />
    </label>
  );
}
