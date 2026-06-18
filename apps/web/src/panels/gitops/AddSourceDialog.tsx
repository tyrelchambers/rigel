// Add-repo wizard. Step 1 (only when GitHub isn't connected): ask for the PAT.
// Step 2: pick a repo, set name/branch, and queue one or more manifest folders as
// deployments before saving. ConnectStep → PickRepoStep flip reactively on the
// `connected` flag, so they live in one module with the DeploymentQueue they drive.
import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Plus, X, Boxes } from "lucide-react";
import {
  useSaveSource,
  useGitHubAccount,
  useConnectGitHub,
  useGitHubRepos,
  type GithubRepo,
} from "./gitApi";
import { GITHUB_TOKEN_URL } from "./GitHubConnectionCard";
import { repoToName, deriveDeployName } from "./gitopsLogic";
import { Field, FormSkeleton } from "./gitopsFormFields";
import { RepoCombobox } from "./RepoCombobox";
import { RepoPathBrowser } from "./RepoPathBrowser";

export function AddSourceDialog({ onClose }: { onClose: () => void }) {
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
