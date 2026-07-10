import { useEffect, useMemo, useState } from "react";
import { Activity, Scale, BadgeCheck, Signpost, Puzzle, type LucideIcon } from "lucide-react";
import { CLUSTER_ADDONS, detectInstalled, type ClusterAddon, type InstalledWorkload } from "@rigel/catalog";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { PanelHeader } from "@/panels/components/PanelHeader";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from "@/components/ui/dialog";
import { useHelmUninstall } from "@/panels/helm/helmApi";
import { useUninstallMetricsServer } from "@/lib/api";
import { PluginInstallSheet } from "./PluginInstallSheet";

const ICONS: Record<string, LucideIcon> = { Activity, Scale, BadgeCheck, Signpost };

interface RawObj { metadata?: { name?: string; namespace?: string } }

function workloadsFrom(resources: Record<string, Record<string, RawObj>>, kind: InstalledWorkload["kind"]): InstalledWorkload[] {
  const map = resources[kind] ?? {};
  return Object.values(map).map((o) => ({
    kind,
    namespace: o.metadata?.namespace ?? "",
    name: o.metadata?.name ?? "",
  }));
}

function uninstallCommand(addon: ClusterAddon): string {
  return addon.install.mode === "helm"
    ? `helm uninstall ${addon.install.releaseName} -n ${addon.install.namespace}`
    : "kubectl delete -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml";
}

/** Destructive confirm shown before an add-on is removed (helm or metrics-server). */
function UninstallConfirm({ addon, running, error, onCancel, onConfirm }: {
  addon: ClusterAddon; running: boolean; error: string | null; onCancel: () => void; onConfirm: () => void;
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{`Uninstall ${addon.name}`}</DialogTitle></DialogHeader>
        <DialogBody>
          <p className="mb-2 text-sm text-muted-foreground">This will run:</p>
          <pre className="overflow-x-auto rounded-md bg-black/30 p-3 text-xs">{uninstallCommand(addon)}</pre>
          {error && <p className="mt-3 text-2xs text-[var(--status-failed)]">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={running}>Cancel</Button>
          <Button variant="destructive" onClick={onConfirm} disabled={running}>{running ? "Removing…" : "Uninstall"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function PluginsPanel() {
  const resources = useCluster((s) => s.resources) as Record<string, Record<string, RawObj>>;
  const [installing, setInstalling] = useState<ClusterAddon | null>(null);
  const [uninstalling, setUninstalling] = useState<ClusterAddon | null>(null);
  const helmUninstall = useHelmUninstall();
  const metricsUninstall = useUninstallMetricsServer();

  useEffect(() => {
    subscribe("deployments", "*");
    subscribe("cronjobs", "*");
    return () => { unsubscribe("deployments", "*"); unsubscribe("cronjobs", "*"); };
  }, []);

  const workloads = useMemo(
    () => [...workloadsFrom(resources, "deployments"), ...workloadsFrom(resources, "cronjobs")],
    [resources],
  );

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="Plugins" subtitle="Cluster add-ons" count={CLUSTER_ADDONS.length} />
      <div className="flex-1 overflow-auto p-3">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
          {CLUSTER_ADDONS.map((addon) => {
            const installed = detectInstalled(addon, workloads);
            const Icon = ICONS[addon.icon] ?? Puzzle;
            return (
              <div key={addon.id} className="flex flex-col gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-4">
                <div className="flex items-center gap-2">
                  <Icon className="size-5 text-[var(--accent-primary)]" />
                  <span className="text-sm font-semibold text-foreground">{addon.name}</span>
                  <span className="ml-auto rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-3xs text-[var(--fg-tertiary)]">{addon.group}</span>
                </div>
                <p className="text-xs text-[var(--fg-secondary)]">{addon.tagline}</p>
                <div className="mt-auto flex items-center justify-between pt-2">
                  <span className={installed ? "text-2xs text-[var(--status-running)]" : "text-2xs text-[var(--fg-tertiary)]"}>
                    {installed ? `Installed · ${addon.detect.namespace}` : "Available"}
                  </span>
                  {installed ? (
                    <Button variant="ghost" size="sm" onClick={() => setUninstalling(addon)}>Uninstall</Button>
                  ) : (
                    <Button size="sm" onClick={() => setInstalling(addon)}>Install</Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {installing && (
        <PluginInstallSheet addon={installing} open onClose={() => setInstalling(null)} onDone={() => setInstalling(null)} />
      )}

      {uninstalling && (
        <UninstallConfirm
          addon={uninstalling}
          running={helmUninstall.isPending || metricsUninstall.isPending}
          error={(helmUninstall.error ?? metricsUninstall.error)?.message ?? null}
          onCancel={() => setUninstalling(null)}
          onConfirm={() => {
            const a = uninstalling;
            if (a.install.mode === "helm") {
              helmUninstall.mutate(
                { release: a.install.releaseName, namespace: a.install.namespace },
                { onSuccess: () => setUninstalling(null) },
              );
            } else {
              metricsUninstall.mutate(undefined, { onSuccess: () => setUninstalling(null) });
            }
          }}
        />
      )}
    </div>
  );
}
