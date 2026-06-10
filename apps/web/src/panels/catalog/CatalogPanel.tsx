import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  LoaderCircle,
  ArrowUp,
  Check,
  HelpCircle,
  RefreshCw,
} from "lucide-react";
import {
  APP_CATEGORIES,
  categoryDisplayName,
  installedAppIDs,
  loadCatalog,
  type AppCategory,
  type CatalogApp,
  type DeploymentLike,
  type StatefulSetLike,
  type PodLike,
} from "@helmsman/catalog";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { useUpdates, type UpdateResult, type ActionBlock } from "@/lib/api";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { iconFor } from "./icons";
import {
  availableCategories,
  filterCatalog,
  requirementsSummary,
  type Scope,
} from "./catalogDisplay";
import { CatalogDetailSheet } from "./CatalogDetailSheet";
import { CatalogInstallWizard } from "./CatalogInstallWizard";
import { updateTargets, withTag, type UpdateTarget } from "./updateTargets";

// Watches the catalog needs cluster-wide (detection scans every namespace) plus
// namespace/node lists for the wizard dropdowns.
const WATCHES: Array<[string, string]> = [
  ["deployments", "*"],
  ["statefulsets", "*"],
  ["pods", "*"],
  ["namespaces", "*"],
  ["nodes", "*"],
];

interface NamedItem {
  metadata?: { name?: string };
}

export default function CatalogPanel() {
  const resources = useCluster((s) => s.resources);

  const [catalog, setCatalog] = useState<CatalogApp[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<AppCategory | null>(null);
  const [scope, setScope] = useState<Scope>("all");
  const [detailApp, setDetailApp] = useState<CatalogApp | null>(null);
  const [wizardApp, setWizardApp] = useState<CatalogApp | null>(null);
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);

  // Load the bundled catalog once.
  useEffect(() => {
    loadCatalog()
      .then((apps) => {
        setCatalog(apps);
        setLoadError(null);
      })
      .catch((err: unknown) =>
        setLoadError(err instanceof Error ? err.message : String(err)),
      );
  }, []);

  // Subscribe to the cluster-wide watches detection + the wizard need.
  useEffect(() => {
    for (const [kind, ns] of WATCHES) subscribe(kind, ns);
    return () => {
      for (const [kind, ns] of WATCHES) unsubscribe(kind, ns);
    };
  }, []);

  const deployments = useMemo(
    () => Object.values((resources["deployments"] ?? {}) as Record<string, DeploymentLike>),
    [resources],
  );
  const statefulSets = useMemo(
    () => Object.values((resources["statefulsets"] ?? {}) as Record<string, StatefulSetLike>),
    [resources],
  );
  const pods = useMemo(
    () => Object.values((resources["pods"] ?? {}) as Record<string, PodLike>),
    [resources],
  );

  // Installed detection — pure, recomputed on every cache/catalog change.
  const installedIDs = useMemo(
    () => installedAppIDs(catalog, deployments, statefulSets, pods),
    [catalog, deployments, statefulSets, pods],
  );

  // Update targets — the running image + workload coordinates for each
  // installed app, so we can both check for updates and emit a setImage action.
  const targets = useMemo(
    () => updateTargets(catalog, deployments, statefulSets, pods),
    [catalog, deployments, statefulSets, pods],
  );
  const targetByApp = useMemo(() => {
    const m = new Map<string, UpdateTarget>();
    for (const t of targets) m.set(t.appID, t);
    return m;
  }, [targets]);

  // One batched /api/updates query for every installed image, cached for the
  // session (TanStack Query owns the TTL; the server does no persistent cache).
  const images = useMemo(() => targets.map((t) => t.image), [targets]);
  const updates = useUpdates(images);
  const resultByImage = useMemo(() => {
    const m = new Map<string, UpdateResult>();
    for (const r of updates.data?.results ?? []) m.set(r.image, r);
    return m;
  }, [updates.data]);

  // Hand off an [Update] click to the guarded ConfirmSheet as a setImage action.
  function onUpdate(target: UpdateTarget, latest: string) {
    setPendingAction({
      kind: "setImage",
      label: `Update ${target.appID} to ${latest}`,
      name: target.workloadName,
      namespace: target.namespace,
      container: target.container,
      image: withTag(target.image, latest),
    });
  }

  const namespaces = useMemo(
    () =>
      Object.values((resources["namespaces"] ?? {}) as Record<string, NamedItem>)
        .map((n) => n.metadata?.name)
        .filter((n): n is string => !!n)
        .sort(),
    [resources],
  );
  const nodeNames = useMemo(
    () =>
      Object.values((resources["nodes"] ?? {}) as Record<string, NamedItem>)
        .map((n) => n.metadata?.name)
        .filter((n): n is string => !!n)
        .sort(),
    [resources],
  );

  const cats = useMemo(() => availableCategories(catalog, APP_CATEGORIES), [catalog]);

  const filtered = useMemo(
    () => filterCatalog(catalog, { scope, installedIDs, category, search }),
    [catalog, scope, installedIDs, category, search],
  );

  const isLoading = catalog.length === 0 && !loadError;

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Catalog</h1>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground">
          {filtered.length}
        </span>
        {isLoading && (
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-label="loading" />
        )}

        {/* Scope toggle */}
        <div className="inline-flex overflow-hidden rounded-md border text-sm">
          <button
            type="button"
            className={`px-3 py-1 ${scope === "all" ? "bg-muted font-medium" : "hover:bg-muted/50"}`}
            onClick={() => setScope("all")}
          >
            All
          </button>
          <button
            type="button"
            className={`px-3 py-1 ${scope === "installed" ? "bg-muted font-medium" : "hover:bg-muted/50"}`}
            onClick={() => setScope("installed")}
          >
            Installed ({installedIDs.size})
          </button>
        </div>

        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search apps, tags…"
          maxLength={280}
          className="ml-auto w-64 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      {/* Category bar */}
      <div className="flex flex-wrap items-center gap-1.5">
        <CategoryPill active={category === null} label="all" onClick={() => setCategory(null)} />
        {cats.map((c) => (
          <CategoryPill
            key={c}
            active={category === c}
            label={categoryDisplayName(c)}
            onClick={() => setCategory(category === c ? null : c)}
          />
        ))}
      </div>

      {/* Load error banner (below category bar) */}
      {loadError && (
        <pre className="rounded-md bg-destructive/10 px-3 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
          {loadError}
        </pre>
      )}

      {/* Grid */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
        {filtered.map((app) => {
          const installed = installedIDs.has(app.id);
          const target = targetByApp.get(app.id);
          const result = target ? resultByImage.get(target.image) : undefined;
          return (
            <CatalogCard
              key={app.id}
              app={app}
              isInstalled={installed}
              onSelect={() => setDetailApp(app)}
              onInstall={() => setWizardApp(app)}
            >
              {installed && target && (
                <UpdateStatusRow
                  checking={updates.isPending && images.length > 0}
                  result={result}
                  onUpdate={(latest) => onUpdate(target, latest)}
                />
              )}
            </CatalogCard>
          );
        })}
      </div>

      {/* Detail sheet */}
      {detailApp && (
        <CatalogDetailSheet
          app={detailApp}
          isInstalled={installedIDs.has(detailApp.id)}
          open
          onOpenChange={(open) => !open && setDetailApp(null)}
          onInstall={() => {
            setWizardApp(detailApp);
            setDetailApp(null);
          }}
        />
      )}

      {/* Install wizard */}
      {wizardApp && (
        <CatalogInstallWizard
          app={wizardApp}
          namespaces={namespaces}
          nodeNames={nodeNames}
          clusterIssuers={[]}
          onClose={() => setWizardApp(null)}
        />
      )}

      {/* setImage confirm sheet for the [Update] button */}
      <ConfirmSheet
        action={pendingAction}
        open={!!pendingAction}
        onClose={() => setPendingAction(null)}
      />
    </div>
  );
}

function CategoryPill({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs ${
        active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70"
      }`}
    >
      {label}
    </button>
  );
}

function CatalogCard({
  app,
  isInstalled,
  onSelect,
  onInstall,
  children,
}: {
  app: CatalogApp;
  isInstalled: boolean;
  onSelect: () => void;
  onInstall: () => void;
  children?: ReactNode;
}) {
  const Icon = iconFor(app.iconSystemName);
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex flex-col gap-2 rounded-lg border bg-card p-3 text-left transition-colors hover:border-ring hover:bg-muted/30"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{app.name}</span>
            {isInstalled && (
              <span className="rounded-full bg-green-500/15 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:text-green-400">
                installed
              </span>
            )}
          </div>
          <p className="truncate text-xs text-muted-foreground">{app.tagline}</p>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="rounded-full bg-muted px-1.5 py-0.5">
          {categoryDisplayName(app.category)}
        </span>
        <span className="truncate font-mono">{requirementsSummary(app)}</span>
      </div>
      {children}
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          onInstall();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.stopPropagation();
            onInstall();
          }
        }}
        className="mt-1 inline-flex items-center justify-center rounded-md border px-2 py-1 text-xs hover:bg-muted"
      >
        Install
      </span>
    </button>
  );
}

/**
 * The per-installed-app update status row. Reflects the /api/updates result:
 *   - checking      → spinner + "checking for updates…"
 *   - updateAvailable → "↑ current → latest" (orange) + [Update] button
 *   - upToDate      → "✓ up to date" (green)
 *   - unknown       → "? version unknown" (gray) + reason tooltip
 *   - not yet cached → "not checked"
 * Interactive children stop propagation so they don't trigger the card's
 * onSelect (the card is itself a button).
 */
function UpdateStatusRow({
  checking,
  result,
  onUpdate,
}: {
  checking: boolean;
  result: UpdateResult | undefined;
  onUpdate: (latest: string) => void;
}) {
  if (checking && !result) {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <LoaderCircle className="size-3 animate-spin" />
        checking for updates…
      </div>
    );
  }

  if (!result) {
    return <div className="text-[11px] text-muted-foreground">not checked</div>;
  }

  if (result.updateAvailable && result.latest) {
    const latest = result.latest;
    return (
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="inline-flex items-center gap-1 truncate font-mono text-amber-600 dark:text-amber-400">
          <ArrowUp className="size-3 shrink-0" />
          {result.currentTag ?? "?"} → {latest}
        </span>
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onUpdate(latest);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.stopPropagation();
              onUpdate(latest);
            }
          }}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-500/40 px-2 py-0.5 text-amber-700 hover:bg-amber-500/10 dark:text-amber-300"
        >
          <RefreshCw className="size-3" />
          Update
        </span>
      </div>
    );
  }

  if (result.kind === "unknown") {
    return (
      <div
        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
        title={result.reason ?? "could not determine an update for this image"}
      >
        <HelpCircle className="size-3" />
        version unknown
      </div>
    );
  }

  // upToDate (no newer version, known tier).
  return (
    <div className="inline-flex items-center gap-1 text-[11px] text-green-700 dark:text-green-400">
      <Check className="size-3" />
      up to date
    </div>
  );
}
