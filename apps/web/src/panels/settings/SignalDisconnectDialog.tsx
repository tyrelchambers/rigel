// Destructive confirm dialog for the Signal "Disconnect" action. Presentation
// only — the actual teardown (clearing assistant-config's Signal keys via the
// setSignal assistant action) lives in SignalSection.disconnect(). Uses the
// standardized Dialog primitives, not a Sheet.

import { AlertTriangle, Unplug } from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  pending: boolean;
  error?: string | null;
}

export function SignalDisconnectDialog({ open, onOpenChange, onConfirm, pending, error }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disconnect Signal</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm leading-relaxed text-muted-foreground">
            This removes the linked phone number and recipients from Rigel&apos;s config.
            Notifications stop immediately. The signal-cli-rest bridge stays deployed, so
            you can re-link anytime.
          </p>
          {error && (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="select-text">{error}</span>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={pending}>
            <Unplug className="size-3.5" />
            {pending ? "Disconnecting…" : "Disconnect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
