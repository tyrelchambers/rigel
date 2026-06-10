import { useEffect, useMemo, useState } from "react";
import { Trash2, Search } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import type { Deployment } from "@/panels/deployments/types";
import { isPurgeableNamespace, groupDeploymentsByNamespace } from "./pickerLogic";

interface PurgePickerSheetProps {
  open: boolean;
  onClose: () => void;
  /** Called when the user picks a deployment → parent opens the PurgeSheet. */
  onPick: (target: { name: string; namespace: string }) => void;
}

/**
 * PurgePickerSheet — searchable list of deployments in purgeable namespaces,
 * grouped by namespace. Selecting a deployment hands its name+namespace to the
 * parent, which opens the typed-name PurgeSheet (discovery runs there).
 *
 * Mirrors the Swift `PurgePickerSheet`. See docs/parity/purge.md.
 */
export function PurgePickerSheet({ open, onClose, onPick }: PurgePickerSheetProps) {
  const [search, setSearch] = useState("");
  const resources = useCluster((s) => s.resources);

  // Subscribe to a cluster-wide deployment watch while the picker is open.
  useEffect(() => {
    if (!open) return;
    subscribe("deployments", "*");
    return () => unsubscribe("deployments", "*");
  }, [open]);

  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const deployments = useMemo(
    () =>
      Object.values((resources["deployments"] ?? {}) as Record<string, Deployment>).filter((d) =>
        isPurgeableNamespace(d.metadata.namespace ?? "default"),
      ),
    [resources],
  );

  const groups = useMemo(
    () => groupDeploymentsByNamespace(deployments, search),
    [deployments, search],
  );

  const hasAny = deployments.length > 0;
  const hasMatches = groups.some((g) => g.deployments.length > 0);

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="bottom" className="max-h-[85vh] overflow-hidden">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Trash2 className="size-4 text-destructive" />
            Purge an app
          </SheetTitle>
          <SheetDescription>
            Pick a deployment to remove. The next step previews every resource and
            requires you to type the app name.
          </SheetDescription>
        </SheetHeader>

        {/* Search */}
        <div className="px-4">
          <div className="flex items-center gap-2 rounded-md border bg-background px-2.5">
            <Search className="size-3.5 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search deployments or namespaces…"
              className="w-full bg-transparent py-1.5 text-sm outline-none"
            />
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-4 pb-4">
          {!hasAny ? (
            <p className="py-3 text-sm text-muted-foreground">No purgeable deployments</p>
          ) : !hasMatches ? (
            <p className="py-3 text-sm text-muted-foreground">No matches.</p>
          ) : (
            <div className="space-y-3">
              {groups
                .filter((g) => g.deployments.length > 0)
                .map((g) => (
                  <div key={g.namespace}>
                    <div className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {g.namespace}
                    </div>
                    <div className="overflow-hidden rounded-md border">
                      {g.deployments.map((name) => (
                        <button
                          key={`${g.namespace}/${name}`}
                          type="button"
                          onClick={() => {
                            onPick({ name, namespace: g.namespace });
                            onClose();
                          }}
                          className="flex w-full items-center border-b px-2.5 py-1.5 text-left font-mono text-xs last:border-b-0 hover:bg-muted/50"
                        >
                          {name}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
