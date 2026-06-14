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
import { Terminal } from "lucide-react";
import { fetchPreviewCommand, type ActionBlock } from "@/lib/api";
import { isDestructiveAction } from "@/lib/actionBlocks";

export interface BatchConfirmItem {
  action: ActionBlock;
  commandString: string;
}

interface Props {
  /** The selected actions to run as a batch, in order. */
  actions: ActionBlock[];
  open: boolean;
  onClose: () => void;
  /** Fired on confirm with each action + its previewed command string. */
  onConfirm: (items: BatchConfirmItem[]) => void;
}

interface Preview {
  command: string[] | null;
  error: string | null;
}

/**
 * BatchConfirmSheet — confirms a queue of chat actions at once, showing the exact
 * kubectl command for each before running. Mirrors ConfirmSheet's shell; the
 * parent (ChatPane) runs them sequentially on confirm. Red/destructive accent if
 * ANY queued action is destructive.
 */
export function BatchConfirmSheet({ actions, open, onClose, onConfirm }: Props) {
  const [previews, setPreviews] = useState<Preview[]>([]);

  useEffect(() => {
    if (!open || actions.length === 0) {
      setPreviews([]);
      return;
    }
    let cancelled = false;
    setPreviews(actions.map(() => ({ command: null, error: null })));
    Promise.all(
      actions.map((a) =>
        fetchPreviewCommand(a)
          .then((command) => ({ command, error: null }) as Preview)
          .catch((e: Error) => ({ command: null, error: e.message }) as Preview),
      ),
    ).then((res) => {
      if (!cancelled) setPreviews(res);
    });
    return () => {
      cancelled = true;
    };
  }, [open, actions]);

  const destructive = actions.some((a) => isDestructiveAction(a));
  const loading = previews.length !== actions.length || previews.some((p) => p.command === null && p.error === null);

  const accentColor = destructive ? "#EF4444" : "#A855F7";
  const accentBorder = destructive ? "rgba(239,68,68,0.5)" : "rgba(168,85,247,0.5)";
  const accentHeaderBg = destructive ? "rgba(239,68,68,0.08)" : "rgba(168,85,247,0.08)";

  function handleConfirm() {
    onConfirm(
      actions.map((action, i) => ({
        action,
        commandString: previews[i]?.command?.join(" ") ?? action.label ?? "kubectl",
      })),
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="overflow-hidden p-0 gap-0" style={{ border: `1px solid ${accentBorder}` }}>
        <DialogHeader
          className="px-4 pt-4 pb-3"
          style={{ background: accentHeaderBg, borderBottom: `1px solid ${accentColor}40` }}
        >
          <DialogTitle>{`Run ${actions.length} action${actions.length === 1 ? "" : "s"}`}</DialogTitle>
          <DialogDescription>
            Review each command before it runs. They run in order and stop at the first failure. This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <div className="p-4">
          <ul className="max-h-72 space-y-2 overflow-auto">
            {actions.map((action, i) => {
              const p = previews[i];
              return (
                <li
                  key={`${action.kind}-${i}`}
                  className="overflow-hidden rounded-lg border border-border bg-background shadow-sm ring-1 ring-foreground/5"
                >
                  <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-1.5">
                    <Terminal className="size-3.5 text-muted-foreground" />
                    <span className="text-[11px] font-semibold text-foreground">{action.label ?? action.kind}</span>
                    {isDestructiveAction(action) && (
                      <span className="ml-auto text-[10px] font-semibold uppercase tracking-wider" style={{ color: "#EF4444" }}>
                        destructive
                      </span>
                    )}
                  </div>
                  {p?.error ? (
                    <p className="px-3 py-2 text-xs text-destructive">{p.error}</p>
                  ) : p?.command ? (
                    <pre className="px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-foreground">
                      <span className="select-none text-muted-foreground">$ </span>
                      {p.command.join(" ")}
                    </pre>
                  ) : (
                    <div className="m-2 h-8 rounded-md border border-border bg-muted/40 animate-pulse" />
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        <DialogFooter className="border-t border-border/40 bg-background/60 px-4 py-3">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            style={{ background: accentColor, color: "#FFFFFF", border: "none" }}
            onClick={handleConfirm}
            disabled={loading}
          >
            {loading ? "Loading…" : `Run all (${actions.length})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
