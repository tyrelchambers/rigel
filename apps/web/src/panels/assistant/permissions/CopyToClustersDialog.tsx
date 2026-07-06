// CopyToClustersDialog — pick which other installed clusters to copy the current
// policy onto. Selection is a checkbox list (never free text). Guarded: the
// parent runs the mutation through the same setRbac path.
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
import type { InstalledContext } from "@/lib/api";

export function CopyToClustersDialog({
  open,
  onOpenChange,
  clusters,
  confirming,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clusters: InstalledContext[];
  confirming: boolean;
  error?: string | null;
  onConfirm: (contexts: string[]) => void;
}) {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const others = clusters.filter((c) => !c.active);
  const selected = others.filter((c) => checked[c.name]).map((c) => c.name);

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
