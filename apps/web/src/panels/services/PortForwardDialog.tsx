import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useStartForward } from "@/lib/api";
import {
  buildLocalPortDefault,
  validateLocalPort,
  type ActiveForward,
} from "./portForward";

export interface PortForwardTarget {
  service: string;
  namespace: string;
  remotePort: number;
}

/**
 * Start-a-forward dialog (docs/parity/portforward.md §"Triggering the Action").
 * Service / namespace / remote port are display-only; the local port is the only
 * input. Validates against the live active list (numeric, 1–65535, not in use)
 * before submitting POST /api/portforward { action: "start" }.
 */
export function PortForwardDialog({
  target,
  activeForwards,
  onClose,
}: {
  target: PortForwardTarget | null;
  activeForwards: ActiveForward[];
  onClose: () => void;
}) {
  const open = target !== null;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {target && (
        <DialogBody key={`${target.namespace}/${target.service}/${target.remotePort}`} target={target} activeForwards={activeForwards} onClose={onClose} />
      )}
    </Dialog>
  );
}

function DialogBody({
  target,
  activeForwards,
  onClose,
}: {
  target: PortForwardTarget;
  activeForwards: ActiveForward[];
  onClose: () => void;
}) {
  const [localPort, setLocalPort] = useState(String(buildLocalPortDefault(target.remotePort)));
  const start = useStartForward();

  const validationError = validateLocalPort(localPort, activeForwards);
  const submitError = start.error?.message ?? null;
  const disabled = validationError !== null || start.isPending;

  function submit() {
    if (validationError !== null) return;
    start.mutate(
      {
        namespace: target.namespace,
        service: target.service,
        remotePort: target.remotePort,
        localPort: Number(localPort.trim()),
      },
      { onSuccess: () => onClose() },
    );
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Forward port</DialogTitle>
        <DialogDescription>
          Forward a local port on the server to{" "}
          <span className="font-mono">
            svc/{target.service}:{target.remotePort}
          </span>
          .
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3">
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <span className="text-muted-foreground">Service</span>
          <span className="font-mono">{target.service}</span>
          <span className="text-muted-foreground">Namespace</span>
          <span className="font-mono">{target.namespace}</span>
          <span className="text-muted-foreground">Remote port</span>
          <span className="font-mono">{target.remotePort}</span>
        </div>

        <label className="block space-y-1">
          <span className="text-sm text-muted-foreground">Local port</span>
          <input
            type="text"
            inputMode="numeric"
            value={localPort}
            autoFocus
            onChange={(e) => setLocalPort(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !disabled) submit();
            }}
            aria-invalid={validationError !== null}
            className="w-full rounded-md border bg-background px-3 py-1.5 font-mono text-sm outline-none focus:ring-2 focus:ring-ring aria-[invalid=true]:border-destructive"
          />
          {validationError && (
            <span className="block text-xs text-destructive">{validationError}</span>
          )}
        </label>

        {submitError && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {submitError}
          </p>
        )}

        {/* Containerized-loopback caveat (docs/parity/portforward.md). */}
        <p className="flex gap-2 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Port forwarding runs inside the server container. The port 127.0.0.1:
            {localPort.trim() || "?"} is reachable from your machine only when running the server
            locally or when the port is published. In containerized deployments, you may need to
            adjust the server's bind address or publish the port.
          </span>
        </p>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={start.isPending}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={disabled}>
          {start.isPending ? "Starting…" : "Start"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
