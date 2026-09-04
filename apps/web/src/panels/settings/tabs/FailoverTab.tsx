import { useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTriangleExclamation } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ClusterConfigNote, clusterLocked } from "../ClusterConfigNote";
import { FailoverDestinationWizard } from "@/panels/failover/destination/FailoverDestinationWizard";
import {
  useDeleteFailoverConfig,
  useFailoverConfig,
  validateFailoverDestination,
  type FailoverValidationView,
} from "@/lib/api";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] py-2.5 last:border-b-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-2xs text-foreground">{value}</span>
    </div>
  );
}

export function FailoverTab() {
  const query = useFailoverConfig();
  const remove = useDeleteFailoverConfig();
  const view = query.data;
  const locked = clusterLocked(view?.cluster);
  const [wizard, setWizard] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [tested, setTested] = useState<FailoverValidationView | null>(null);
  const [testing, setTesting] = useState(false);

  async function test() {
    setTesting(true);
    setTested(null);
    try {
      setTested(await validateFailoverDestination({}));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4 rounded-[14px] border border-[var(--border-subtle)] bg-card p-[18px]">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-foreground">Failover destination</h2>
        {view?.configured && (
          <span className="flex items-center gap-1.5 rounded border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2 py-1 text-2xs text-[var(--fg-tertiary)]">
            <span className="size-1.5 rounded-full bg-[var(--status-running)]" />
            DigitalOcean saved
          </span>
        )}
      </div>

      {view?.cluster && <ClusterConfigNote cluster={view.cluster} />}

      {!locked && !view?.configured && (
        <>
          <p className="text-xs leading-snug text-muted-foreground">
            Set this up ahead of time so a storm-time failover is one click. Nothing is created in DigitalOcean until
            you run one.
          </p>
          <div>
            <Button size="sm" onClick={() => setWizard(true)}>
              Set up a destination
            </Button>
          </div>
        </>
      )}

      {!locked && view?.configured && (
        <>
          <div className="flex flex-col">
            <Row label="Provider" value="DigitalOcean" />
            <Row label="Region" value={view.region} />
            <Row label="Cluster" value={`${view.nodeCount} × ${view.nodeSize}`} />
            <Row
              label="Object store"
              value={view.objectStore ? `${view.objectStore.bucket} · ${view.objectStore.endpoint}` : "Not set"}
            />
            <Row
              label="Edge"
              value={view.edge ? `${view.edge.host} · ${view.edge.backends.length} servers` : "Not set"}
            />
            <Row label="API token" value={view.tokenSet ? "stored" : "not set"} />
          </div>

          {view.objectStore && (
            <p className="flex items-start gap-2 text-xs text-[var(--status-pending)]">
              <FontAwesomeIcon icon={faTriangleExclamation} aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span>
                A store inside the cluster you would be failing away from goes down with the building. Test the
                connection to check where this one lives.
              </span>
            </p>
          )}

          {tested && (
            <p className={`text-xs ${tested.ok ? "text-[var(--status-running)]" : "text-[var(--status-failed)]"}`}>
              {tested.api.ok
                ? tested.objectStore && !tested.objectStore.ok
                  ? tested.objectStore.error
                  : `Signed in as ${tested.api.email || "your account"}.`
                : tested.api.error}
            </p>
          )}
          {remove.error && <p className="text-xs text-[var(--status-failed)]">{remove.error.message}</p>}

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => setWizard(true)}>
              Edit destination
            </Button>
            <Button size="sm" variant="outline" disabled={testing} onClick={test}>
              {testing ? "Checking…" : "Test connection"}
            </Button>
            <Button size="sm" variant="destructive" onClick={() => setConfirmRemove(true)}>
              Remove destination
            </Button>
          </div>
        </>
      )}

      <FailoverDestinationWizard open={wizard} onOpenChange={setWizard} view={view} />

      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <DialogContent className="w-[420px] p-5">
          <DialogTitle className="text-sm font-semibold">Remove this destination?</DialogTitle>
          <p className="text-xs text-muted-foreground">
            A failover will have nowhere to go until you set one up again. Nothing in DigitalOcean is touched.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setConfirmRemove(false)}>
              Keep it
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate(undefined, { onSuccess: () => setConfirmRemove(false) })}
            >
              Remove
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
