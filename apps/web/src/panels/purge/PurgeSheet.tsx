import { useEffect, useMemo, useState } from "react";
import { Trash2, Lock, CheckCircle2, XCircle } from "lucide-react";
import { Loader } from "@/components/Loader";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  usePurgeDiscovery,
  usePurgeExecute,
  type PurgeExecuteResultEntry,
} from "@/lib/api";
import type { PlanResource, PurgePlan } from "./types";
import { defaultSelectedForKind } from "./types";

interface PurgeSheetProps {
  /** The app to purge: root deployment name + namespace. Null = closed. */
  target: { name: string; namespace: string } | null;
  open: boolean;
  onClose: () => void;
}

/**
 * PurgeSheet — the typed-name app-removal confirm sheet.
 *
 * On open it runs a dry-run discovery (`POST /api/purge dryRun=true`), builds a
 * PurgePlan, and renders a per-resource toggle list. The Purge button is gated
 * by THREE conditions (all required):
 *   1. blockedReason is null (namespace not protected),
 *   2. at least one resource selected,
 *   3. typed text EXACTLY matches appName (case-sensitive).
 * Pressing Return in the confirm input does NOT submit — the button is the gate.
 *
 * Mirrors the Swift `PurgeSheet`. See docs/parity/purge.md.
 */
export function PurgeSheet({ target, open, onClose }: PurgeSheetProps) {
  const discovery = usePurgeDiscovery();
  const exec = usePurgeExecute();

  const [plan, setPlan] = useState<PurgePlan | null>(null);
  const [confirmText, setConfirmText] = useState("");

  // Run discovery whenever the sheet opens against a new target.
  useEffect(() => {
    if (!open || !target) {
      setPlan(null);
      setConfirmText("");
      discovery.reset();
      exec.reset();
      return;
    }
    setConfirmText("");
    exec.reset();
    discovery.mutate(
      { namespace: target.namespace, instance: target.name },
      {
        onSuccess: (res) => {
          const resources: PlanResource[] = res.discovered.map((d) => ({
            kind: d.kind,
            name: d.name,
            namespace: d.namespace,
            selected: defaultSelectedForKind(d.kind),
          }));
          setPlan({
            appName: target.name,
            namespace: target.namespace,
            resources,
            helmRelease: res.helmRelease,
            blockedReason: res.blockedReason,
            dropDatabase: false,
          });
        },
      },
    );
    // discovery/exec are stable mutation objects; intentionally narrow deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target?.name, target?.namespace]);

  const blocked = plan?.blockedReason != null && plan.blockedReason !== "";
  const selectedCount = useMemo(
    () => plan?.resources.filter((r) => r.selected).length ?? 0,
    [plan],
  );
  const nameMatches = plan != null && confirmText === plan.appName;
  const canPurge = !blocked && selectedCount > 0 && nameMatches && !exec.isPending;

  function toggleResource(index: number) {
    setPlan((p) => {
      if (!p) return p;
      const resources = p.resources.map((r, i) =>
        i === index ? { ...r, selected: !r.selected } : r,
      );
      return { ...p, resources };
    });
  }

  function toggleDropDatabase() {
    setPlan((p) => (p ? { ...p, dropDatabase: !p.dropDatabase } : p));
  }

  function handlePurge() {
    if (!plan || !canPurge) return;
    const selected = plan.resources.filter((r) => r.selected);
    exec.mutate({
      namespace: plan.namespace,
      instance: plan.appName,
      helmRelease: plan.helmRelease ?? null,
      resources: selected.map((r) => ({
        kind: r.kind,
        name: r.name,
        namespace: r.namespace,
      })),
      dropDatabase: plan.dropDatabase,
      databaseHint: plan.databaseHint ?? null,
    });
  }

  function handleClose() {
    discovery.reset();
    exec.reset();
    onClose();
  }

  const appName = plan?.appName ?? target?.name ?? "";
  const namespace = plan?.namespace ?? target?.namespace ?? "";

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <DialogContent
        className="p-0 gap-0 border-t-2 border-destructive/50 max-h-[85vh] overflow-hidden max-w-2xl"
      >
        <div className="flex flex-col gap-0.5 p-4">
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="size-4 text-destructive" />
            <span>Purge {appName}</span>
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">
            namespace: {namespace}
          </DialogDescription>
        </div>

        {/* Loading discovery */}
        {discovery.isPending && (
          <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
            <Loader size={16} />
            Discovering resources…
          </div>
        )}

        {/* Discovery error */}
        {discovery.isError && (
          <div className="px-4 py-2">
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {discovery.error.message}
            </p>
          </div>
        )}

        {/* Blocked state — protected namespace */}
        {plan && blocked && (
          <div className="mx-4 my-2 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-3">
            <Lock className="mt-0.5 size-4 shrink-0 text-destructive" />
            <p className="text-sm text-destructive">{plan.blockedReason}</p>
          </div>
        )}

        {/* Normal state */}
        {plan && !blocked && (
          <div className="flex flex-col gap-3 overflow-y-auto px-4">
            {/* Warning prose */}
            <p className="text-xs text-muted-foreground">
              This permanently deletes the selected resources from the cluster.
              Deselect anything that should survive — the typed-name confirmation
              below is the real gate.
            </p>

            {/* Helm note */}
            {plan.helmRelease && (
              <p className="rounded-md bg-muted px-3 py-2 text-xs">
                Helm-managed:{" "}
                <span className="font-mono">helm uninstall {plan.helmRelease}</span>{" "}
                runs first.
              </p>
            )}

            {/* Resource list */}
            {plan.resources.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">No resources to delete.</p>
            ) : (
              <div className="max-h-[240px] overflow-y-auto rounded-md border">
                {plan.resources.map((r, i) => (
                  <button
                    key={`${r.kind}/${r.namespace}/${r.name}`}
                    type="button"
                    onClick={() => toggleResource(i)}
                    className="flex w-full items-center gap-2 border-b px-2.5 py-1.5 text-left last:border-b-0 hover:bg-muted/50"
                  >
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded border",
                        r.selected
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-input bg-background",
                      )}
                      aria-checked={r.selected}
                      role="checkbox"
                    >
                      {r.selected && <CheckCircle2 className="size-3" />}
                    </span>
                    <span className="shrink-0 rounded bg-accent/40 px-1.5 py-0.5 font-mono text-[10px] text-accent-foreground">
                      {r.kind}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{r.name}</span>
                  </button>
                ))}
              </div>
            )}

            {/* Selection summary */}
            {plan.resources.length > 0 && (
              <p className="text-[11px] text-muted-foreground">
                {selectedCount} of {plan.resources.length} selected
              </p>
            )}

            {/* Database hint */}
            {plan.databaseHint && (
              <button
                type="button"
                onClick={toggleDropDatabase}
                className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-left"
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border",
                    plan.dropDatabase
                      ? "border-destructive bg-destructive text-destructive-foreground"
                      : "border-destructive/50 bg-background",
                  )}
                  aria-checked={plan.dropDatabase}
                  role="checkbox"
                >
                  {plan.dropDatabase && <CheckCircle2 className="size-3" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-semibold text-destructive">
                    Also drop database {plan.databaseHint} — irreversible
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    Deletes the app's logical database inside the shared server. Off by default.
                  </span>
                </span>
              </button>
            )}

            {/* Confirm input */}
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Confirm
              </label>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                onKeyDown={(e) => {
                  // Return must NOT submit — the button is the only gate.
                  if (e.key === "Enter") e.preventDefault();
                }}
                placeholder={`type ${appName} to confirm`}
                className={cn(
                  "w-full rounded-md border bg-background px-3 py-1.5 font-mono text-xs outline-none",
                  nameMatches
                    ? "border-destructive ring-2 ring-destructive/30"
                    : "focus:ring-2 focus:ring-ring",
                )}
              />
            </div>

            {/* Execute results */}
            {exec.data && (
              <div className="rounded-md border">
                {exec.data.results.map((res, i) => (
                  <ResultRow key={`${res.resource}-${i}`} result={res} />
                ))}
              </div>
            )}
            {exec.isError && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {exec.error.message}
              </p>
            )}
          </div>
        )}

        <div className="mt-auto flex flex-col gap-2 p-4 flex-row justify-end">
          <Button variant="outline" onClick={handleClose} disabled={exec.isPending}>
            Cancel
          </Button>
          {!blocked && (
            <Button variant="destructive" onClick={handlePurge} disabled={!canPurge}>
              {exec.isPending ? (
                <Loader size={16} />
              ) : (
                <Trash2 />
              )}
              Purge
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** One execute-result row: green check / red x + resource + detail. */
function ResultRow({ result }: { result: PurgeExecuteResultEntry }) {
  return (
    <div className="flex items-center gap-2 border-b px-2.5 py-1.5 text-xs last:border-b-0">
      {result.ok ? (
        <CheckCircle2 className="size-3.5 shrink-0 text-green-600" />
      ) : (
        <XCircle className="size-3.5 shrink-0 text-destructive" />
      )}
      <span className="shrink-0 font-mono">{result.resource}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{result.detail}</span>
    </div>
  );
}
