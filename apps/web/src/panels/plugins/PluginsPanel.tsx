import { useEffect, useMemo, useState } from "react";
import { Activity, Scale, BadgeCheck, Signpost, Puzzle, Search, type LucideIcon } from "lucide-react";
import { CLUSTER_ADDONS, detectInstalled, type ClusterAddon, type AddonGroup, type InstalledWorkload } from "@rigel/catalog";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from "@/components/ui/dialog";
import { InfoTooltip } from "@/components/InfoTooltip";
import { TabBar, Tab } from "@/components/ui/Tabs";
import { useHelmUninstall } from "@/panels/helm/helmApi";
import { useUninstallMetricsServer } from "@/lib/api";
import { PluginInstallSheet } from "./PluginInstallSheet";

const ICONS: Record<string, LucideIcon> = { Activity, Scale, BadgeCheck, Signpost };
const GROUPS: AddonGroup[] = [...new Set(CLUSTER_ADDONS.map((a) => a.group))];

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
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState<AddonGroup | null>(null);
  const [scope, setScope] = useState<"all" | "installed">("all");
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
  const installedIds = useMemo(
    () => new Set(CLUSTER_ADDONS.filter((a) => detectInstalled(a, workloads)).map((a) => a.id)),
    [workloads],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return CLUSTER_ADDONS.filter((a) => {
      if (group && a.group !== group) return false;
      if (scope === "installed" && !installedIds.has(a.id)) return false;
      if (q && !a.name.toLowerCase().includes(q) && !a.tagline.toLowerCase().includes(q) && !a.group.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [search, group, scope, installedIds]);

  return (
    <div className="catalog-root h-full overflow-auto px-4">
      <div className="catalog-atmosphere" aria-hidden />

      <div className="catalog-header">
        <div className="catalog-header-top">
          <div className="catalog-title-group">
            <div className="flex items-center gap-2">
              <h1 className="catalog-title">Plugins</h1>
              <InfoTooltip label="Install and manage cluster add-ons" />
            </div>
          </div>

          <div className="catalog-header-controls">
            <div className="catalog-search-wrap">
              <Search className="catalog-search-icon" aria-hidden />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search add-ons…"
                maxLength={280}
                className="catalog-search-input"
                aria-label="Search add-ons"
              />
            </div>

            <TabBar value={scope} onValueChange={(id) => setScope(id as typeof scope)}>
              <Tab value="all">All</Tab>
              <Tab value="installed" badge={installedIds.size}>Installed</Tab>
            </TabBar>
          </div>
        </div>

        <div className="catalog-category-rail" role="group" aria-label="Filter by group">
          <button type="button" className={`catalog-cat-pill${group === null ? " active" : ""}`} onClick={() => setGroup(null)}>All</button>
          {GROUPS.map((g) => (
            <button
              key={g}
              type="button"
              className={`catalog-cat-pill${group === g ? " active" : ""}`}
              onClick={() => setGroup(group === g ? null : g)}
            >
              {g}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="catalog-empty">
          <p className="catalog-empty-title">No add-ons match</p>
          <p className="catalog-empty-sub">Try a different search or filter.</p>
        </div>
      ) : (
        <div className="catalog-grid">
          {filtered.map((addon) => {
            const installed = installedIds.has(addon.id);
            const Icon = ICONS[addon.icon] ?? Puzzle;
            return (
              <article key={addon.id} className="catalog-card" aria-label={`${addon.name} — ${addon.tagline}`}>
                <div className="catalog-card-top">
                  <div className="catalog-icon-tile" aria-hidden>
                    <Icon className="catalog-icon-glyph" />
                  </div>
                  <div className="catalog-card-meta">
                    <div className="catalog-card-name-row">
                      <span className="catalog-card-name">{addon.name}</span>
                      {installed && (
                        <span className="catalog-installed-badge" aria-label="Installed">
                          <span className="catalog-installed-dot" />
                          Installed
                        </span>
                      )}
                    </div>
                    <p className="catalog-card-tagline">{addon.tagline}</p>
                  </div>
                </div>

                <div className="catalog-card-chips">
                  <span className="catalog-chip catalog-chip-category">{addon.group}</span>
                  {installed && (
                    <span className="catalog-chip catalog-chip-req" title={`Namespace: ${addon.detect.namespace}`}>
                      {addon.detect.namespace}
                    </span>
                  )}
                </div>

                <div className="catalog-card-footer">
                  {installed ? (
                    <button type="button" className="catalog-btn-manage" onClick={() => setUninstalling(addon)} aria-label={`Uninstall ${addon.name}`}>
                      Uninstall
                    </button>
                  ) : (
                    <button type="button" className="catalog-btn-install" onClick={() => setInstalling(addon)} aria-label={`Install ${addon.name}`}>
                      Install
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

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
