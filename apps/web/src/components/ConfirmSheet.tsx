import { useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { fetchPreviewCommand, useAction, type ActionBlock, type PurgeResult } from "@/lib/api";

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
}

/**
 * ConfirmSheet — shows the EXACT kubectl command that will be executed before
 * running it. Mirrors the Swift `WorkloadConfirmSheet` confirm gate.
 *
 * Usage:
 *   <ConfirmSheet action={pendingAction} open={!!pendingAction} onClose={() => setPendingAction(null)} />
 */
export function ConfirmSheet({ action, open, onClose, onPurge }: ConfirmSheetProps) {
  const [previewCommand, setPreviewCommand] = useState<string[] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const { mutate, isPending, isSuccess, isError, error, data, reset } = useAction();

  // Fetch the preview command whenever the action changes
  useEffect(() => {
    if (!action || !open) {
      setPreviewCommand(null);
      setPreviewError(null);
      reset();
      return;
    }

    // purge has no kubectl preview
    if (action.kind === "purge") {
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

  function handleExecute() {
    if (!action) return;
    mutate(action, {
      onSuccess: (result) => {
        // If the server signals this is a purge, defer to the purge flow
        if ("purge" in result && result.purge) {
          const p = result as PurgeResult;
          onPurge?.(p.name, p.namespace);
          onClose();
        }
      },
    });
  }

  function handleClose() {
    reset();
    onClose();
  }

  const isPurge = action?.kind === "purge";
  const isDestructive = action?.destructive === true || isPurge;
  const commandString = previewCommand ? previewCommand.join(" ") : null;

  // Auto-close on success for non-purge actions (purge defers to onPurge callback)
  useEffect(() => {
    if (isSuccess && data && !("purge" in data && data.purge)) {
      // Give a moment so the user sees the result, then close
      const t = setTimeout(() => { reset(); onClose(); }, 1200);
      return () => clearTimeout(t);
    }
  }, [isSuccess, data, reset, onClose]);

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <SheetContent side="bottom">
        <SheetHeader>
          <SheetTitle>
            {isPurge ? "Remove application" : (action?.label ?? "Confirm action")}
          </SheetTitle>
          <SheetDescription>
            {isPurge
              ? "This will open the application removal flow. No resources will be deleted until you confirm in the next step."
              : "Review the exact command before it runs. This cannot be undone."}
          </SheetDescription>
        </SheetHeader>

        {/* Command preview */}
        {!isPurge && (
          <div className="px-4 py-2">
            {previewError ? (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {previewError}
              </p>
            ) : commandString ? (
              <pre className="rounded-md bg-muted px-3 py-2 text-xs font-mono whitespace-pre-wrap break-all">
                {commandString}
              </pre>
            ) : (
              <div className="h-8 rounded-md bg-muted animate-pulse" />
            )}
          </div>
        )}

        {/* Result feedback */}
        {isSuccess && data && !("purge" in data && data.purge) && (
          <div className="px-4 py-1">
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
          <div className="px-4 py-1">
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error.message}
            </p>
          </div>
        )}

        <SheetFooter>
          <Button variant="outline" onClick={handleClose} disabled={isPending}>
            Cancel
          </Button>
          <Button
            variant={isDestructive ? "destructive" : "default"}
            onClick={handleExecute}
            disabled={isPending || (!isPurge && !commandString && !previewError)}
          >
            {isPending ? "Running…" : isPurge ? "Continue to removal" : "Execute"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
