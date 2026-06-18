// Edit a YAML file inside a configured GitOps source, then open a PR. Lists the
// source's manifest folder, opens a clicked .yaml file in the Monaco editor, and
// hands the edited content to the existing proposeRepoFix flow (diff preview →
// PR) via the guarded ConfirmSheet. Nothing is applied to the cluster.
import { useEffect, useState } from "react";
import { Folder, FileText } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { YamlEditor } from "@/components/YamlEditorLazy";
import { useClusterYamlSchema } from "@/lib/useClusterYamlSchema";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import type { ActionBlock } from "@/lib/api";
import { useRepoTree, useRepoFile, type GitSource, type GitDeployment } from "./gitApi";

export function GitOpsFileEditDialog({ repo, dep, onClose }: { repo: GitSource; dep: GitDeployment; onClose: () => void }) {
  const repoFullName = repo.repoURL.replace(/\.git$/, "").replace(/^https?:\/\/github\.com\//, "");
  const [folder, setFolder] = useState(dep.path || ".");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [proposeAction, setProposeAction] = useState<ActionBlock | null>(null);
  const { data: schema } = useClusterYamlSchema();

  const apiPath = folder === "." ? "" : folder;
  const { data: entries, isLoading } = useRepoTree(repoFullName, repo.branch, apiPath, true);
  const file = useRepoFile(repoFullName, repo.branch, filePath);

  // Seed the editor with the file's content once it loads (and re-seed when the
  // selected file changes). Keyed on filePath so switching files re-seeds.
  useEffect(() => {
    if (file.data?.content !== undefined) setDraft(file.data.content);
  }, [file.data, filePath]);

  const dirs = (entries ?? []).filter((e) => e.type === "dir");
  const yamlFiles = (entries ?? []).filter((e) => e.type === "file" && /\.ya?ml$/i.test(e.name));

  function openFile(path: string) {
    setDraft("");
    setFilePath(path);
  }

  function handlePropose() {
    if (!filePath) return;
    setProposeAction({
      kind: "proposeRepoFix",
      source: dep.name,
      filePath,
      content: draft,
      title: `Update ${filePath}`,
      label: `Open PR: Update ${filePath}`,
    });
  }

  return (
    <>
      <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-[15px]">{dep.name}</DialogTitle>
            <DialogDescription className="text-xs">
              {repoFullName} · {repo.branch} — edit a manifest and open a PR (nothing is applied).
            </DialogDescription>
          </DialogHeader>

          {!filePath ? (
            <div className="max-h-[60vh] overflow-auto rounded-lg" style={{ background: "#08080A", border: "1px solid #26272B" }}>
              {isLoading && <div className="px-2.5 py-2 text-xs text-muted-foreground">Loading…</div>}
              {folder !== "." && (
                <button type="button" onClick={() => setFolder(folder.split("/").slice(0, -1).join("/") || ".")} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-white/[0.04]">
                  <Folder className="size-3.5 shrink-0" style={{ color: "var(--accent-primary)" }} /> ..
                </button>
              )}
              {dirs.map((d) => (
                <button key={d.path} type="button" onClick={() => setFolder(d.path)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-white/[0.04]">
                  <Folder className="size-3.5 shrink-0" style={{ color: "var(--accent-primary)" }} />
                  <span className="font-mono">{d.name}/</span>
                </button>
              ))}
              {yamlFiles.map((f) => (
                <button key={f.path} type="button" onClick={() => openFile(f.path)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-white/[0.04]">
                  <FileText className="size-3.5 shrink-0" style={{ color: "var(--fg-tertiary)" }} />
                  <span className="font-mono">{f.name}</span>
                </button>
              ))}
              {!isLoading && dirs.length === 0 && yamlFiles.length === 0 && (
                <div className="px-2.5 py-2 text-xs text-muted-foreground">No YAML files here.</div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-muted-foreground">{filePath}</span>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => { setFilePath(null); setDraft(""); }}>Back</Button>
                  <Button size="sm" onClick={handlePropose} disabled={file.isLoading || draft === ""}>Open PR…</Button>
                </div>
              </div>
              {file.isLoading ? (
                <div className="py-10 text-center text-sm text-muted-foreground">Loading file…</div>
              ) : (
                <div style={{ height: "60vh", borderRadius: 8, overflow: "hidden", border: "1px solid #26272B" }}>
                  <YamlEditor value={draft} onChange={setDraft} schema={schema ?? null} />
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmSheet action={proposeAction} open={!!proposeAction} onClose={() => setProposeAction(null)} />
    </>
  );
}
