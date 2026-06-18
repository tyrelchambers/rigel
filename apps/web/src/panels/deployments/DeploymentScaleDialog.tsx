import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { Deployment } from "./types";

interface DeploymentScaleDialogProps {
  target: Deployment | null;
  value: string;
  onValueChange: (value: string) => void;
  onConfirm: () => void;
  onClose: () => void;
  /** Clamped replica count for the confirm-button label (the panel owns the clamp). */
  scaleN: number;
}

/** Deployment scale prompt. Extracted verbatim from DeploymentsPanel. */
export function DeploymentScaleDialog({ target, value, onValueChange, onConfirm, onClose, scaleN }: DeploymentScaleDialogProps) {
  return (
    <Dialog open={!!target} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Scale {target?.metadata.name}</DialogTitle>
          <DialogDescription>Enter replica count (0–50).</DialogDescription>
        </DialogHeader>
        <input
          type="number"
          min={0}
          max={50}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onConfirm(); }}
          className="w-full rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
          aria-label="Replica count"
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={onConfirm}>Scale to {scaleN}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
