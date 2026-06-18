// Two-step guarded sync: load the kubectl diff preview, then apply on confirm.
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
import { CheckCircle2 } from "lucide-react";
import { syncDeployment, type SyncResult } from "./gitApi";
import type { DeploymentRef } from "./gitopsLogic";

export function SyncDialog({ target, onClose }: { target: DeploymentRef; onClose: () => void }) {
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
