// ReviewDialog — the diff confirm before a staged RbacPolicy is applied.
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { diffPolicies, type RbacPolicy } from "@rigel/k8s";

/** Humanize a grant cell (`${apiGroup}|${resource}|${verb}`) as "<verb> <resource>". */
export function humanizeCell(c: string): string {
  const [, resource, verb] = c.split("|");
  return `${verb} ${resource}`;
}

export function ReviewDialog({
  open,
  onOpenChange,
  applied,
  staged,
  targetLabel,
  confirming,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applied: RbacPolicy;
  staged: RbacPolicy;
  targetLabel: string;
  confirming: boolean;
  error?: string | null;
  onConfirm: () => void;
}) {
  const diff = diffPolicies(applied, staged);
  const hasChanges = diff.added.length + diff.removed.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Review changes</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <DialogDescription>Applying to {targetLabel}.</DialogDescription>
          {hasChanges ? (
            <ul className="mt-3 space-y-1 font-mono text-[12.5px]">
              {diff.added.map((c) => (
                <li key={`added-${c}`} className="text-green-500">
                  + {humanizeCell(c)}
                </li>
              ))}
              {diff.removed.map((c) => (
                <li key={`removed-${c}`} className="text-red-400">
                  − {humanizeCell(c)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">No pending changes.</p>
          )}
          {error && <p className="mt-3 font-mono text-[11px] text-[var(--status-failed)]">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" disabled={confirming} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={confirming || !hasChanges} onClick={onConfirm}>
            {confirming ? "Applying…" : "Apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
