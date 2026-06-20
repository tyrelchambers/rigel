import { CircleCheck } from "lucide-react";
import type { CatalogApp } from "@rigel/catalog";
import { Button } from "@/components/ui/button";
import type { ConfigureValues } from "../wizardLogic";

/** Step 7 — Done. Success summary + Close. */
export function DoneStep({
  app,
  values,
  onClose,
}: {
  app: CatalogApp;
  values: ConfigureValues;
  onClose: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <CircleCheck className="size-5 text-green-600 dark:text-green-400" />
        <span className="font-medium">{app.name} installed</span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <div className="text-muted-foreground">Instance</div>
        <div className="font-mono">{values.instance}</div>
        <div className="text-muted-foreground">Namespace</div>
        <div className="font-mono">{values.namespace}</div>
        {app.exposesIngress && values.hostname && (
          <>
            <div className="text-muted-foreground">Hostname</div>
            <div className="font-mono">{values.hostname}</div>
          </>
        )}
      </div>
      <div className="flex justify-end">
        <Button type="button" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}
