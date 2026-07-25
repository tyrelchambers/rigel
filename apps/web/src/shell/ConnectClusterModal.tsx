import { useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCloud } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogIcon, DialogTitle } from "@/components/ui/dialog";
import { ConnectClusterBody, CONNECT_CLUSTER_TITLE } from "./ConnectClusterBody";

export function ConnectClusterModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [title, setTitle] = useState(CONNECT_CLUSTER_TITLE);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogIcon>
            <FontAwesomeIcon icon={faCloud} className="size-[17px]" />
          </DialogIcon>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <ConnectClusterBody active={open} onDone={() => onOpenChange(false)} onTitleChange={setTitle} />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
