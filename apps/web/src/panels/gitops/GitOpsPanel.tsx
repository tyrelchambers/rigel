// GitOps — deploy manifests from a GitHub repo. The GitHub PAT is managed in the
// Accounts panel; here, "Add source" is a wizard that asks for the token first
// (only if not connected), then lets you PICK a repo. "Sync now": the server
// clones the repo, shows a kubectl diff preview, and applies on confirm.
// Manual-trigger v1 (no polling/webhooks).
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
import { GitBranch, Plus, RefreshCw, Trash2, CheckCircle2, AlertTriangle, FolderGit2, X, Check, Folder, FileText } from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import type { ActionBlock } from "@/lib/api";
import type { Deployment } from "@/panels/deployments/types";
import {
  useGitSources,
  useSaveSource,
  useDeleteSource,
  useGitHubAccount,
  useConnectGitHub,
  useGitHubRepos,
  useRepoTree,
  syncSource,
  type GitSource,
  type GithubRepo,
  type SyncResult,
} from "./gitApi";
import { GITHUB_TOKEN_URL } from "./GitHubConnectionCard";
import { buildLinkAction, buildUnlinkAction, linkedSourceName, type WorkloadRef } from "./linkSource";

export default function GitOpsPanel() {
  const { data: sources, isLoading } = useGitSources();
  const [addOpen, setAddOpen] = useState(false);
  const [syncing, setSyncing] = useState<GitSource | null>(null);
  const [linkingSource, setLinkingSource] = useState<GitSource | null>(null);
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);
  const del = useDeleteSource();

  // Workloads (for the per-source "linked deployments" view + link picker).
  const namespaceFilter = useCluster((s) => s.namespaceFilter);
  const resources = useCluster((s) => s.resources);
  useEffect(() => {
    const ns = namespaceFilter ?? "*";
    subscribe("deployments", ns);
    return () => unsubscribe("deployments", ns);
  }, [namespaceFilter]);
  const deployments = useMemo(
    () => Object.values((resources["deployments"] ?? {}) as Record<string, Deployment>),
    [resources],
  );
  /** sourceName → linked deployments. */
  const linkedBySource = useMemo(() => {
    const map = new Map<string, Deployment[]>();
    for (const d of deployments) {
      const src = linkedSourceName(d);
      if (!src) continue;
      const list = map.get(src);
      if (list) list.push(d);
      else map.set(src, [d]);
    }
    return map;
  }, [deployments]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <PanelHeader title="GitOps" subtitle="Deploy manifests from a Git repo" count={sources?.length} loading={isLoading}>
        <Button size="sm" className="gap-1.5" onClick={() => setAddOpen(true)}>
          <Plus className="size-3.5" /> Add source
        </Button>
      </PanelHeader>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        {sources && sources.length === 0 && (
          <div style={{ textAlign: "center", color: "var(--fg-tertiary)", padding: "48px 0", fontSize: 13 }}>
            <FolderGit2 className="mx-auto mb-3 size-8 opacity-50" />
            No Git sources yet. Add a repo to deploy its manifests.
          </div>
        )}
        {sources?.map((s) => (
          <SourceCard
            key={s.name}
            source={s}
            linked={linkedBySource.get(s.name) ?? []}
            onSync={() => setSyncing(s)}
            onDelete={() => del.mutate(s.name)}
            onLinkDeployment={() => setLinkingSource(s)}
            onUnlink={(w) => setPendingAction(buildUnlinkAction(w))}
            deleting={del.isPending && del.variables === s.name}
          />
        ))}
      </div>

      {addOpen && <AddSourceDialog onClose={() => setAddOpen(false)} />}
      {syncing && <SyncDialog source={syncing} onClose={() => setSyncing(null)} />}
      {linkingSource && (
        <LinkDeploymentDialog
          source={linkingSource}
          deployments={deployments}
          onPick={(a) => { setPendingAction(a); setLinkingSource(null); }}
          onClose={() => setLinkingSource(null)}
        />
      )}
      <ConfirmSheet action={pendingAction} open={!!pendingAction} onClose={() => setPendingAction(null)} />
    </div>
  );
}

function SourceCard({
  source,
  linked,
  onSync,
  onDelete,
  onLinkDeployment,
  onUnlink,
  deleting,
}: {
  source: GitSource;
  linked: Deployment[];
  onSync: () => void;
  onDelete: () => void;
  onLinkDeployment: () => void;
  onUnlink: (w: WorkloadRef) => void;
  deleting: boolean;
}) {
  return (
    <div style={{ borderRadius: 12, border: "1px solid #26272B", background: "var(--surface-elevated)", padding: 14 }}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg" style={{ background: "var(--accent-primary)18", border: "1px solid #26272B" }}>
          <GitBranch className="size-4" style={{ color: "var(--accent-primary)" }} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-semibold">{source.name}</span>
          <span className="truncate font-mono text-xs" style={{ color: "var(--fg-tertiary)" }}>
            {source.repoURL} · {source.branch} · {source.path}
          </span>
          <SyncStatus source={source} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={onSync}>
            <RefreshCw className="size-3.5" /> Sync now
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete} disabled={deleting} aria-label={`Remove ${source.name}`}>
            <Trash2 className="size-3.5" style={{ color: "var(--status-failed)" }} />
          </Button>
        </div>
      </div>

      {/* Linked workloads — the AI uses these links for context + fix-PRs. */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t pt-2.5" style={{ borderColor: "var(--border-subtle)" }}>
        <span className="text-[11px]" style={{ color: "var(--fg-tertiary)" }}>Linked:</span>
        {linked.length === 0 && <span className="text-[11px]" style={{ color: "var(--fg-tertiary)" }}>none yet</span>}
        {linked.map((d) => (
          <span key={`${d.metadata.namespace}/${d.metadata.name}`} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-mono" style={{ background: "var(--surface-sunken)", border: "1px solid #26272B" }}>
            {d.metadata.name}
            <button
              type="button"
              aria-label={`Unlink ${d.metadata.name}`}
              onClick={() => onUnlink({ name: d.metadata.name, namespace: d.metadata.namespace ?? "default", kind: "deployment" })}
              className="opacity-60 hover:opacity-100"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <Button size="sm" variant="ghost" className="ml-auto h-6 gap-1 text-[11px]" onClick={onLinkDeployment}>
          <Plus className="size-3" /> Link deployment
        </Button>
      </div>
    </div>
  );
}

/** Pick a deployment to link to a source (lists those not already on this source). */
function LinkDeploymentDialog({
  source,
  deployments,
  onPick,
  onClose,
}: {
  source: GitSource;
  deployments: Deployment[];
  onPick: (a: ActionBlock) => void;
  onClose: () => void;
}) {
  const candidates = deployments
    .filter((d) => linkedSourceName(d) !== source.name)
    .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Link a deployment to {source.name}</DialogTitle>
          <DialogDescription>The workload is tagged with this source so the AI has context and can open fix-PRs.</DialogDescription>
        </DialogHeader>
        <div className="max-h-80 overflow-auto py-1">
          {candidates.length === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-muted-foreground">No deployments available to link.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {candidates.map((d) => {
                const ref: WorkloadRef = { name: d.metadata.name, namespace: d.metadata.namespace ?? "default", kind: "deployment" };
                const already = linkedSourceName(d);
                return (
                  <li key={`${ref.namespace}/${ref.name}`}>
                    <button
                      type="button"
                      onClick={() => onPick(buildLinkAction(ref, source))}
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

function SyncStatus({ source }: { source: GitSource }) {
  if (!source.lastSyncedAt) {
    return <span className="text-[11px]" style={{ color: "var(--fg-tertiary)" }}>Never synced</span>;
  }
  const when = new Date(source.lastSyncedAt).toLocaleString();
  const sha = source.lastSyncedSha?.slice(0, 7);
  if (source.lastStatus === "error") {
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
  return repo.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Add-source wizard. Step 1 (only when GitHub isn't connected): ask for the PAT
 * with a link to create one — saving it flips `connected`, which advances to
 * step 2. Step 2: pick a repo (skeletons while the repo list loads).
 */
function AddSourceDialog({ onClose }: { onClose: () => void }) {
  const { data: account, isLoading: acctLoading } = useGitHubAccount();
  const connected = account?.connected === true;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-2xl">
        {acctLoading ? (
          <>
            <DialogHeader>
              <DialogTitle>Add Git source</DialogTitle>
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

/** Step 2 — pick a repo (skeletons while the list loads), then save the source. */
function PickRepoStep({ onClose }: { onClose: () => void }) {
  const save = useSaveSource();
  const { data: repos, isLoading, isError, error } = useGitHubRepos(true);
  const [fullName, setFullName] = useState("");
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [path, setPath] = useState(".");

  const selected = useMemo<GithubRepo | undefined>(() => repos?.find((r) => r.fullName === fullName), [repos, fullName]);

  function pickRepo(fn: string) {
    setFullName(fn);
    const r = repos?.find((x) => x.fullName === fn);
    if (r) {
      setName(repoToName(r.fullName));
      setBranch(r.defaultBranch);
      setPath("."); // reset the folder browser to the repo root
    }
  }

  const canSave = !!selected && name.trim() !== "" && !save.isPending;

  async function handleSave() {
    if (!selected) return;
    try {
      await save.mutateAsync({ name, repoURL: selected.cloneURL, branch: branch || selected.defaultBranch, path });
      onClose();
    } catch {
      /* error shown below */
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add Git source</DialogTitle>
        <DialogDescription>Pick a repo from your GitHub account; its manifests deploy on Sync.</DialogDescription>
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
                  <Field label="Name" value={name} onChange={setName} placeholder="my-app" />
                  <Field label="Branch" value={branch} onChange={setBranch} placeholder={selected.defaultBranch} />
                </div>
                <RepoPathBrowser repo={selected.fullName} branch={branch || selected.defaultBranch} value={path} onChange={setPath} />
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
        <Button onClick={handleSave} disabled={!canSave}>{save.isPending ? "Saving…" : "Add source"}</Button>
      </DialogFooter>
    </>
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
function SyncDialog({ source, onClose }: { source: GitSource; onClose: () => void }) {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<"diffing" | "preview" | "applying" | "done">("diffing");
  const [diff, setDiff] = useState<SyncResult | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Kick off the diff once on mount.
  useEffect(() => {
    let cancelled = false;
    syncSource(source.name, true)
      .then((r) => { if (!cancelled) { setDiff(r); setPhase("preview"); } })
      .catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setPhase("preview"); } });
    return () => { cancelled = true; };
  }, [source.name]);

  async function handleApply() {
    setPhase("applying");
    try {
      const r = await syncSource(source.name, false);
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
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Sync {source.name}</DialogTitle>
          <DialogDescription>{source.repoURL} · {source.branch} · {source.path}</DialogDescription>
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
