// Add a single deployment to an existing repo (the card's "Add deployment").
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useSaveDeployment, type GitSource } from "./gitApi";
import { deriveDeployName } from "./gitopsLogic";
import { Field } from "./gitopsFormFields";
import { RepoPathBrowser } from "./RepoPathBrowser";

export function AddDeploymentDialog({ repo, onClose }: { repo: GitSource; onClose: () => void }) {
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
