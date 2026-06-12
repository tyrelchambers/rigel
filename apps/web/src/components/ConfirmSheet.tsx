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
import { Terminal, Copy, Check } from "lucide-react";
import { fetchPreviewCommand, useAction, type ActionBlock, type PurgeResult } from "@/lib/api";

interface ConfirmSheetProps {
  /** A single action to confirm (back-compat). */
  action?: ActionBlock | null;
  /** An ordered batch of actions to confirm and run sequentially. Takes precedence over `action`. */
  actions?: ActionBlock[];
  /** Controlled open state. */
  open: boolean;
  /** Called when the sheet should close (cancelled or after execution). */
  onClose: () => void;
  /**
   * Called when the action is a `purge` — the parent should open the
   * typed-name purge confirm sheet instead.
   */
  onPurge?: (name: string | null, namespace: string) => void;
}

/**
 * ConfirmSheet — shows the EXACT kubectl command(s) that will be executed before
 * running them. Mirrors the Swift `WorkloadConfirmSheet` confirm gate.
 *
 * Single-action usage (back-compat):
 *   <ConfirmSheet action={pendingAction} open={!!pendingAction} onClose={() => setPendingAction(null)} />
 *
 * Batch usage:
 *   <ConfirmSheet actions={pendingActions} open={!!pendingActions} onClose={() => setPendingActions(null)} />
 */
export function ConfirmSheet({ action, actions, open, onClose, onPurge }: ConfirmSheetProps) {
  const list = actions ?? (action ? [action] : []);
  const primary = list[0] ?? null;

  const [previewCommands, setPreviewCommands] = useState<string[][] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { mutateAsync, isPending, reset } = useAction();

  // Fetch preview commands whenever the list changes or the sheet opens
  useEffect(() => {
    if (!list.length || !open) {
      setPreviewCommands(null);
      setPreviewError(null);
      setRunError(null);
      reset();
      return;
    }

    // purge has no kubectl preview
    if (primary?.kind === "purge") {
      setPreviewCommands(null);
      setPreviewError(null);
      return;
    }

    let cancelled = false;
    setPreviewCommands(null);
    setPreviewError(null);
    setRunError(null);
    Promise.all(list.map((a) => fetchPreviewCommand(a)))
      .then((cmds) => { if (!cancelled) setPreviewCommands(cmds); })
      .catch((err: Error) => { if (!cancelled) setPreviewError(err.message); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, JSON.stringify(list), reset]);

  async function handleExecute() {
    if (!list.length) return;
    setRunError(null);
    for (const a of list) {
      try {
        const result = await mutateAsync(a);
        if ("purge" in result && result.purge) {
          const p = result as PurgeResult;
          onPurge?.(p.name, p.namespace);
          onClose();
          return;
        }
        if ("code" in result && result.code !== 0) {
          setRunError(result.stderr || result.stdout || "Command failed");
          return;
        }
      } catch (e) {
        setRunError(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    setTimeout(() => { reset(); onClose(); }, 1000);
  }

  function handleClose() {
    reset();
    onClose();
  }

  const isPurge = primary?.kind === "purge";
  const isDestructive = primary?.destructive === true || isPurge;

  function handleCopy() {
    if (!previewCommands) return;
    const text = previewCommands.map((cmd) => `$ ${cmd.join(" ")}`).join("\n");
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isPurge ? "Remove application" : (primary?.label ?? "Confirm action")}
          </DialogTitle>
          <DialogDescription>
            {isPurge
              ? "This will open the application removal flow. No resources will be deleted until you confirm in the next step."
              : "Review the exact command before it runs. This cannot be undone."}
          </DialogDescription>
        </DialogHeader>

        {/* Command preview(s) */}
        {!isPurge && (
          <div>
            {previewError ? (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {previewError}
              </p>
            ) : previewCommands ? (
              <div>
                <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-1.5 rounded-t-lg border border-border">
                  <Terminal className="size-3.5 text-muted-foreground" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {previewCommands.length === 1 ? "Command" : "Commands"}
                  </span>
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <div className="space-y-0 overflow-hidden rounded-b-lg border border-t-0 border-border bg-background shadow-sm ring-1 ring-foreground/5">
                  {previewCommands.map((cmd, i) => (
                    <pre
                      key={i}
                      className={`px-3 py-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-foreground${i > 0 ? " border-t border-border/40" : ""}`}
                    >
                      <span className="select-none text-muted-foreground">$ </span>
                      {cmd.join(" ")}
                    </pre>
                  ))}
                </div>
              </div>
            ) : (
              <div className="h-14 rounded-lg border border-border bg-muted/40 animate-pulse" />
            )}
          </div>
        )}

        {/* Run error feedback */}
        {runError && (
          <div>
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {runError}
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={isPending}>
            Cancel
          </Button>
          <Button
            variant={isDestructive ? "destructive" : "default"}
            onClick={() => { void handleExecute(); }}
            disabled={isPending || (!isPurge && !previewCommands && !previewError)}
          >
            {isPending ? "Running…" : isPurge ? "Continue to removal" : "Execute"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
