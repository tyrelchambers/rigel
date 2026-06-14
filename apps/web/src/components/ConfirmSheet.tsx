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
import { fetchPreviewCommand, useAction, applyManifestYaml, type ActionBlock, type ActionResult, type PurgeResult } from "@/lib/api";
import { listResources } from "@helmsman/catalog";
import { isDestructiveAction } from "@/lib/actionBlocks";

interface ConfirmSheetProps {
  /** The action to confirm and optionally execute. */
  action: ActionBlock | null;
  /** Controlled open state. */
  open: boolean;
  /** Called when the sheet should close (cancelled or after execution). */
  onClose: () => void;
  /**
   * Called when the action is a `purge` — the parent should open the
   * typed-name purge confirm sheet instead.
   */
  onPurge?: (name: string | null, namespace: string) => void;
  /**
   * Set when this sheet was opened from the chat, so the run result is reported
   * back to the parent (ChatPane) which feeds it into the claude session.
   */
  fromChat?: boolean;
  /**
   * Fires after a chat-initiated action runs (success OR failure), with the
   * result and the exact previewed command — parity with Swift's executeWorkload
   * closing the loop. Only called when `fromChat` is set.
   */
  onResult?: (info: { action: ActionBlock; result: ActionResult; commandString: string }) => void;
}

/**
 * ConfirmSheet — shows the EXACT kubectl command that will be executed before
 * running it. Mirrors the Swift `WorkloadConfirmSheet` confirm gate.
 *
 * Usage:
 *   <ConfirmSheet action={pendingAction} open={!!pendingAction} onClose={() => setPendingAction(null)} />
 */
export function ConfirmSheet({ action, open, onClose, onPurge, fromChat, onResult }: ConfirmSheetProps) {
  const [previewCommand, setPreviewCommand] = useState<string[] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [applyState, setApplyState] = useState<{ pending: boolean; result?: ActionResult; error?: string }>({ pending: false });

  const { mutate, isPending, isSuccess, isError, error, data, reset } = useAction();

  // Fetch the preview command whenever the action changes
  useEffect(() => {
    if (!action || !open) {
      setPreviewCommand(null);
      setPreviewError(null);
      setApplyState({ pending: false });
      reset();
      return;
    }

    // purge and applyManifest have no kubectl preview
    if (action.kind === "purge" || action.kind === "applyManifest") {
      setPreviewCommand(null);
      setPreviewError(null);
      return;
    }

    let cancelled = false;
    setPreviewCommand(null);
    setPreviewError(null);
    fetchPreviewCommand(action)
      .then((cmd) => { if (!cancelled) setPreviewCommand(cmd); })
      .catch((err: Error) => { if (!cancelled) setPreviewError(err.message); });
    return () => { cancelled = true; };
  }, [action, open, reset]);

  async function handleApply() {
    const act = action;
    if (!act?.manifest) return;
    const cmd = act.label ?? "kubectl apply -f -";
    setApplyState({ pending: true });
    try {
      const result = await applyManifestYaml(act.manifest);
      setApplyState({ pending: false, result });
      if (fromChat) onResult?.({ action: act, result, commandString: cmd });
      if (result.code === 0) setTimeout(() => handleClose(), 1200);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setApplyState({ pending: false, error: message });
      if (fromChat) onResult?.({ action: act, result: { code: 1, stdout: "", stderr: message }, commandString: cmd });
    }
  }

  function handleExecute() {
    if (!action) return;
    const act = action;
    const cmd = previewCommand ? previewCommand.join(" ") : (act.label ?? "kubectl");
    mutate(act, {
      onSuccess: (result) => {
        // If the server signals this is a purge, defer to the purge flow
        if ("purge" in result && result.purge) {
          const p = result as PurgeResult;
          onPurge?.(p.name, p.namespace);
          onClose();
          return;
        }
        // Close the loop: hand the result back to the chat session (parity with
        // Swift executeWorkload) so the model knows it ran and can continue.
        if (fromChat) onResult?.({ action: act, result: result as ActionResult, commandString: cmd });
      },
      onError: (err) => {
        // A failed run still closes the loop so the model can diagnose it.
        if (fromChat) {
          const message = err instanceof Error ? err.message : String(err);
          onResult?.({ action: act, result: { code: 1, stdout: "", stderr: message }, commandString: cmd });
        }
      },
    });
  }

  function handleClose() {
    reset();
    setApplyState({ pending: false });
    onClose();
  }

  const isPurge = action?.kind === "purge";
  const isApply = action?.kind === "applyManifest";
  // Destructive treatment follows the shared rule (delete/drain/purge family or
  // the model's `destructive` hint), plus applyManifest which is app-specific.
  const isDestructive = (action ? isDestructiveAction(action) : false) || isApply;
  const commandString = previewCommand ? previewCommand.join(" ") : null;

  function handleCopy() {
    if (!commandString) return;
    void navigator.clipboard.writeText(commandString).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  // Auto-close on success for non-purge actions (purge defers to onPurge callback)
  useEffect(() => {
    if (isSuccess && data && !("purge" in data && data.purge)) {
      // Give a moment so the user sees the result, then close
      const t = setTimeout(() => { reset(); onClose(); }, 1200);
      return () => clearTimeout(t);
    }
  }, [isSuccess, data, reset, onClose]);

  // Swift: accent = isHighRisk ? Theme.Status.failed : Theme.Accent.primary
  // The dialog border and header tint both follow `accent`.
  const accentColor = isDestructive ? "#EF4444" : "#A855F7";
  const accentBorder = isDestructive ? "rgba(239,68,68,0.5)" : "rgba(168,85,247,0.5)";
  const accentHeaderBg = isDestructive ? "rgba(239,68,68,0.08)" : "rgba(168,85,247,0.08)";

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <DialogContent
        className="overflow-hidden p-0 gap-0"
        style={{ border: `1px solid ${accentBorder}` }}
      >
        {/* Swift header: accent.opacity(0.08) background, title + description */}
        <DialogHeader
          className="px-4 pt-4 pb-3"
          style={{ background: accentHeaderBg, borderBottom: `1px solid ${accentColor}40` }}
        >
          <DialogTitle>
            {isPurge
              ? "Remove application"
              : isApply
              ? (action?.label ?? "Apply manifest")
              : (action?.label ?? "Confirm action")}
          </DialogTitle>
          <DialogDescription>
            {isPurge
              ? "This will open the application removal flow. No resources will be deleted until you confirm in the next step."
              : isApply
              ? "Review what will be created, then apply."
              : "Review the exact command before it runs. This cannot be undone."}
          </DialogDescription>
        </DialogHeader>
        {/* Body content wrapper with padding — mirrors Swift body_content padding(18) */}
        <div className="p-4 flex flex-col gap-4">

        {/* Apply manifest resource summary */}
        {isApply && action?.manifest && (() => {
          const resources = listResources(action.manifest);
          return (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                This will apply {resources.length} resource{resources.length === 1 ? "" : "s"}:
              </p>
              <ul className="max-h-60 space-y-1 overflow-auto rounded-md border bg-background/40 p-2 text-xs font-mono">
                {resources.map((r, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <span className="text-primary">{r.kind}</span>
                    <span className="text-foreground">/{r.name || "—"}</span>
                    {r.namespace && <span className="text-muted-foreground">({r.namespace})</span>}
                  </li>
                ))}
              </ul>
              {applyState.error && (
                <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{applyState.error}</p>
              )}
              {applyState.result && (applyState.result.code === 0
                ? <p className="text-xs text-muted-foreground">Applied.</p>
                : <pre className="rounded-md bg-destructive/10 px-3 py-2 text-xs font-mono text-destructive whitespace-pre-wrap">{applyState.result.stderr || applyState.result.stdout}</pre>
              )}
            </div>
          );
        })()}

        {/* Command preview */}
        {!isPurge && !isApply && (
          <div>
            {previewError ? (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {previewError}
              </p>
            ) : commandString ? (
              <div className="overflow-hidden rounded-lg border border-border bg-background shadow-sm ring-1 ring-foreground/5">
                <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-1.5">
                  <Terminal className="size-3.5 text-muted-foreground" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Command
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
                <pre className="px-3 py-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-foreground">
                  <span className="select-none text-muted-foreground">$ </span>
                  {commandString}
                </pre>
              </div>
            ) : (
              <div className="h-14 rounded-lg border border-border bg-muted/40 animate-pulse" />
            )}
          </div>
        )}

        {/* Result feedback */}
        {isSuccess && data && !("purge" in data && data.purge) && (
          <div>
            {"code" in data && data.code !== 0 ? (
              <pre className="rounded-md bg-destructive/10 px-3 py-2 text-xs font-mono text-destructive whitespace-pre-wrap">
                {data.stderr || data.stdout}
              </pre>
            ) : (
              <p className="text-xs text-muted-foreground">Command succeeded.</p>
            )}
          </div>
        )}

        {isError && (
          <div>
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error.message}
            </p>
          </div>
        )}

        </div>{/* end body content wrapper */}

        {/* Swift footer: Theme.Surface.primary bg + subtle top border */}
        <DialogFooter
          className="-mx-0 -mb-0 rounded-b-none border-t border-border/40 bg-background/60 px-4 py-3"
        >
          <Button variant="outline" onClick={handleClose} disabled={isPending || applyState.pending}>
            Cancel
          </Button>
          {/* Swift Execute button: solid `accent` fill, always — not the dim destructive/10 variant */}
          <Button
            style={{ background: accentColor, color: "#FFFFFF", border: "none" }}
            onClick={isApply ? handleApply : handleExecute}
            disabled={isApply ? applyState.pending : (isPending || (!isPurge && !commandString && !previewError))}
          >
            {isApply
              ? (applyState.pending ? "Applying…" : "Apply")
              : isPending
              ? "Running…"
              : isPurge
              ? "Continue to removal"
              : "Execute"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
