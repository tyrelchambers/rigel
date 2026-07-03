import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface HelmConfirmModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** The exact helm argv to display, e.g. ["uninstall","web","-n","apps"]. */
  command: string[];
  running: boolean;
  error?: string | null;
  /** Red confirm treatment for removals (e.g. uninstall). */
  destructive?: boolean;
  onConfirm: () => void;
}

export function HelmConfirmModal({ open, onOpenChange, title, command, running, error, destructive, onConfirm }: HelmConfirmModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="mb-2 text-sm text-muted-foreground">This will run:</p>
          <pre className="overflow-x-auto rounded-md bg-black/30 p-3 text-xs">
            {["helm", ...command].join(" ")}
          </pre>
          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>
            Cancel
          </Button>
          <Button variant={destructive ? "destructive" : "default"} onClick={onConfirm} disabled={running}>
            {running ? "Running…" : "Run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
