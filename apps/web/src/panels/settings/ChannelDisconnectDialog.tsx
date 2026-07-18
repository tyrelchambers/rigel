// Destructive confirm dialog for disconnecting a notification channel
// (Signal, Matrix). Presentation only — the actual teardown (clearing the
// channel's keys in assistant-config via the setSignal/setMatrix action) lives
// in the calling section's disconnect() handler. Uses the standardized Dialog
// primitives, not a Sheet.

import { type ReactNode } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTriangleExclamation, faPlugCircleXmark } from "@awesome.me/kit-6050953220/icons/classic/solid";
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
  /** Channel name, shown as "Disconnect {channel}" in the title. */
  channel: string;
  /** Body copy explaining what this disconnect tears down. */
  description: ReactNode;
  /** Teardown error, surfaced inside the dialog (not the card banner behind it). */
  error?: string | null;
}

export function ChannelDisconnectDialog({
  open,
  onOpenChange,
  onConfirm,
  pending,
  channel,
  description,
  error,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disconnect {channel}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
          {error && (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              <FontAwesomeIcon icon={faTriangleExclamation} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="select-text">{error}</span>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={pending}>
            <FontAwesomeIcon icon={faPlugCircleXmark} className="size-3.5" />
            {pending ? "Disconnecting…" : "Disconnect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
