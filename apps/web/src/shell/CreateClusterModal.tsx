import { useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faBoxesStacked } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogIcon, DialogTitle } from "@/components/ui/dialog";
import { sendClusterStop } from "@/lib/ws";
import { CreateClusterBody } from "./CreateClusterBody";

export function CreateClusterModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => { if (!o && busy) sendClusterStop(); onOpenChange(o); }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogIcon>
            <FontAwesomeIcon icon={faBoxesStacked} className="size-[17px]" />
          </DialogIcon>
          <DialogTitle>Create cluster</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <CreateClusterBody active={open} onDone={() => onOpenChange(false)} onBusyChange={setBusy} />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
