// CopyToClustersDialog — pick which other installed clusters to copy the current
// policy onto, showing the diff being pushed. Selection is a checkbox list
// (never free text). Guarded: the parent runs the mutation through setRbac.
import { useState } from "react";
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
import { humanizeCell } from "./ReviewDialog";
import type { InstalledContext } from "@/lib/api";

export function CopyToClustersDialog({
  open,
  onOpenChange,
  clusters,
  applied,
  staged,
  confirming,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clusters: InstalledContext[];
  applied: RbacPolicy;
  staged: RbacPolicy;
  confirming: boolean;
  error?: string | null;
  onConfirm: (contexts: string[]) => void;
}) {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const others = clusters.filter((c) => !c.active);
  const selected = others.filter((c) => checked[c.name]).map((c) => c.name);
  const diff = diffPolicies(applied, staged);
  const hasChanges = diff.added.length + diff.removed.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Copy permissions to clusters</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <DialogDescription>
            Apply this cluster&apos;s current permissions to the clusters you select.
          </DialogDescription>
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
            <p className="mt-3 text-sm text-muted-foreground">
              No pending changes — copies the current saved policy.
            </p>
          )}
          {others.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No other installed clusters.</p>
          ) : (
            <ul className="mt-3 space-y-1">
              {others.map((c) => (
                <li key={c.name}>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      aria-label={c.name}
                      checked={!!checked[c.name]}
                      onChange={(e) => setChecked((m) => ({ ...m, [c.name]: e.target.checked }))}
                      className="size-[15px] accent-[var(--accent-primary)]"
                    />
                    <span className="font-mono text-[12.5px]">{c.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {error && <p className="mt-3 font-mono text-[11px] text-[var(--status-failed)]">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" disabled={confirming} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={confirming || selected.length === 0} onClick={() => onConfirm(selected)}>
            {confirming ? "Copying…" : `Copy to ${selected.length || ""} cluster${selected.length === 1 ? "" : "s"}`.trim()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
