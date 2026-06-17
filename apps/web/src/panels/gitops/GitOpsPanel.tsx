// GitOps — deploy manifests from a GitHub repo. Add a source (repo + branch +
// path + PAT), then "Sync now": the server clones the repo, shows a kubectl diff
// preview, and applies on confirm. Manual-trigger v1 (no polling/webhooks).
import { useEffect, useState } from "react";
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
import { GitBranch, Plus, RefreshCw, Trash2, CheckCircle2, AlertTriangle, FolderGit2 } from "lucide-react";
import {
  useGitSources,
  useSaveSource,
  useDeleteSource,
  syncSource,
  type GitSource,
  type SyncResult,
} from "./gitApi";

export default function GitOpsPanel() {
  const { data: sources, isLoading } = useGitSources();
  const [addOpen, setAddOpen] = useState(false);
  const [syncing, setSyncing] = useState<GitSource | null>(null);
  const del = useDeleteSource();

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
            onSync={() => setSyncing(s)}
            onDelete={() => del.mutate(s.name)}
            deleting={del.isPending && del.variables === s.name}
          />
        ))}
      </div>

      {addOpen && <AddSourceDialog onClose={() => setAddOpen(false)} />}
      {syncing && <SyncDialog source={syncing} onClose={() => setSyncing(null)} />}
    </div>
  );
}

function SourceCard({
  source,
  onSync,
  onDelete,
  deleting,
}: {
  source: GitSource;
  onSync: () => void;
  onDelete: () => void;
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
    </div>
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

function AddSourceDialog({ onClose }: { onClose: () => void }) {
  const save = useSaveSource();
  const [name, setName] = useState("");
  const [repoURL, setRepoURL] = useState("");
  const [branch, setBranch] = useState("main");
  const [path, setPath] = useState(".");
  const [token, setToken] = useState("");

  const canSave = name.trim() !== "" && repoURL.trim() !== "" && !save.isPending;

  async function handleSave() {
    try {
      await save.mutateAsync({ name, repoURL, branch, path, token: token || undefined });
      onClose();
    } catch {
      /* error shown below */
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Git source</DialogTitle>
          <DialogDescription>Point Helmsman at a GitHub repo of manifests. The token is stored as a cluster Secret.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-1">
          <Field label="Name" value={name} onChange={setName} placeholder="my-app" />
          <Field label="Repository URL" value={repoURL} onChange={setRepoURL} placeholder="https://github.com/me/my-app" />
          <div className="flex gap-3">
            <Field label="Branch" value={branch} onChange={setBranch} placeholder="main" />
            <Field label="Manifest path" value={path} onChange={setPath} placeholder="." />
          </div>
          <Field label="Personal access token" value={token} onChange={setToken} placeholder="ghp_… (leave blank for public repos)" type="password" />
          {save.isError && (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{save.error.message}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button onClick={handleSave} disabled={!canSave}>{save.isPending ? "Saving…" : "Add source"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
