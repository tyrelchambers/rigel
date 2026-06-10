import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  LoaderCircle,
  ArrowUp,
  Check,
  HelpCircle,
  RefreshCw,
  Search,
  Cpu,
  MemoryStick,
  HardDrive,
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
    <div className="catalog-root">
      {/* Atmosphere layer — subtle radial glow + dot grid */}
      <div className="catalog-atmosphere" aria-hidden />

      {/* Sticky header */}
      <div className="catalog-header">
        <div className="catalog-header-top">
          <div className="catalog-title-group">
            <h1 className="catalog-title">Apps</h1>
            <p className="catalog-subtitle">Install and manage cluster applications</p>
          </div>

          <div className="catalog-header-controls">
            {/* Scope segmented control */}
            <div className="catalog-scope-control">
              <button
                type="button"
                className={`catalog-scope-btn${scope === "all" ? " active" : ""}`}
                onClick={() => setScope("all")}
              >
                All
              </button>
              <button
                type="button"
                className={`catalog-scope-btn${scope === "installed" ? " active" : ""}`}
                onClick={() => setScope("installed")}
              >
                Installed
                <span className="catalog-scope-count">{installedIDs.size}</span>
              </button>
            </div>

            {/* Search */}
            <div className="catalog-search-wrap">
              <Search className="catalog-search-icon" aria-hidden />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search apps, tags…"
                maxLength={280}
                className="catalog-search-input"
                aria-label="Search apps"
              />
              {isLoading && (
                <LoaderCircle className="catalog-search-spinner" aria-label="loading" />
              )}
            </div>
          </div>
        </div>

        {/* Category pill rail */}
        <div className="catalog-category-rail" role="group" aria-label="Filter by category">
          <CategoryPill active={category === null} label="All" onClick={() => setCategory(null)} />
          {cats.map((c) => (
            <CategoryPill
              key={c}
              active={category === c}
              label={categoryDisplayName(c)}
              onClick={() => setCategory(category === c ? null : c)}
            />
          ))}
        </div>
      </div>

      {/* Load error banner */}
      {loadError && (
        <pre className="catalog-error">{loadError}</pre>
      )}

      {/* Grid */}
      {isLoading ? (
        <div className="catalog-grid">
          {Array.from({ length: 12 }).map((_, i) => (
            <SkeletonCard key={i} index={i} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState search={search} scope={scope} />
      ) : (
        <div className="catalog-grid">
          {filtered.map((app, i) => {
            const installed = installedIDs.has(app.id);
            const target = targetByApp.get(app.id);
            const result = target ? resultByImage.get(target.image) : undefined;
            return (
              <CatalogCard
                key={app.id}
                app={app}
                isInstalled={installed}
                index={i}
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
      )}

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

// ─── Category Pill ────────────────────────────────────────────────────────────

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
      className={`catalog-cat-pill${active ? " active" : ""}`}
    >
      {label}
    </button>
  );
}

// ─── App Card ─────────────────────────────────────────────────────────────────

function CatalogCard({
  app,
  isInstalled,
  index,
  onSelect,
  onInstall,
  children,
}: {
  app: CatalogApp;
  isInstalled: boolean;
  index: number;
  onSelect: () => void;
  onInstall: () => void;
  children?: ReactNode;
}) {
  const Icon = iconFor(app.iconSystemName);
  // Stagger: cap at first 12, then no delay
  const delayMs = index < 12 ? index * 40 : 0;
  const cardStyle = { animationDelay: `${delayMs}ms` } as React.CSSProperties;

  return (
    <article
      className="catalog-card"
      style={cardStyle}
      role="button"
      tabIndex={0}
      aria-label={`${app.name} — ${app.tagline}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      {/* Top row: icon + name/tagline + installed badge */}
      <div className="catalog-card-top">
        {/* Icon tile — flat neutral so it doesn't pop */}
        <div className="catalog-icon-tile" aria-hidden>
          <Icon className="catalog-icon-glyph" />
        </div>

        <div className="catalog-card-meta">
          <div className="catalog-card-name-row">
            <span className="catalog-card-name">{app.name}</span>
            {isInstalled && (
              <span className="catalog-installed-badge" aria-label="Installed">
                <span className="catalog-installed-dot" />
                Installed
              </span>
            )}
          </div>
          <p className="catalog-card-tagline">{app.tagline}</p>
        </div>
      </div>

      {/* Chips row: category + resource requirements */}
      <div className="catalog-card-chips">
        <span className="catalog-chip catalog-chip-category">
          {categoryDisplayName(app.category)}
        </span>
        <span className="catalog-chip catalog-chip-req" title={`CPU: ${app.requirements.cpuRequest}${app.requirements.cpuLimit ? ` → ${app.requirements.cpuLimit}` : ""}`}>
          <Cpu className="catalog-chip-icon" aria-hidden />
          {app.requirements.cpuRequest}
        </span>
        <span className="catalog-chip catalog-chip-req" title={`Memory: ${app.requirements.memoryRequest}${app.requirements.memoryLimit ? ` → ${app.requirements.memoryLimit}` : ""}`}>
          <MemoryStick className="catalog-chip-icon" aria-hidden />
          {app.requirements.memoryRequest}
        </span>
        {app.requirements.storageGiB != null && (
          <span className="catalog-chip catalog-chip-req" title={`Storage: ${app.requirements.storageGiB} GiB`}>
            <HardDrive className="catalog-chip-icon" aria-hidden />
            {app.requirements.storageGiB}Gi
          </span>
        )}
      </div>

      {/* Update status row (for installed apps) */}
      {children && <div className="catalog-card-update">{children}</div>}

      {/* Action footer */}
      <div className="catalog-card-footer">
        {isInstalled ? (
          <button
            type="button"
            className="catalog-btn-manage"
            onClick={(e) => {
              e.stopPropagation();
              onSelect();
            }}
            aria-label={`Manage ${app.name}`}
          >
            Manage
          </button>
        ) : (
          <button
            type="button"
            className="catalog-btn-install"
            onClick={(e) => {
              e.stopPropagation();
              onInstall();
            }}
            aria-label={`Install ${app.name}`}
          >
            Install
          </button>
        )}
      </div>
    </article>
  );
}

// ─── Update Status Row ────────────────────────────────────────────────────────

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
      <div className="catalog-update-row">
        <LoaderCircle className="catalog-update-spin" aria-hidden />
        <span>Checking for updates…</span>
      </div>
    );
  }

  if (!result) {
    return <div className="catalog-update-row catalog-update-dim">Not checked</div>;
  }

  if (result.updateAvailable && result.latest) {
    const latest = result.latest;
    return (
      <div className="catalog-update-row">
        <span className="catalog-update-chip catalog-update-chip-diff">
          <ArrowUp className="size-3 shrink-0" aria-hidden />
          {result.currentTag ?? "?"} → {latest}
        </span>
        <button
          type="button"
          className="catalog-update-btn"
          onClick={(e) => {
            e.stopPropagation();
            onUpdate(latest);
          }}
          aria-label={`Update to ${latest}`}
        >
          <RefreshCw className="size-3" aria-hidden />
          Update
        </button>
      </div>
    );
  }

  if (result.kind === "unknown") {
    return (
      <div className="catalog-update-row">
        <span
          className="catalog-update-chip catalog-update-chip-unknown"
          title={result.reason ?? "Could not determine an update for this image"}
        >
          <HelpCircle className="size-3 shrink-0" aria-hidden />
          version unknown
        </span>
      </div>
    );
  }

  return (
    <div className="catalog-update-row">
      <span className="catalog-update-chip catalog-update-chip-ok">
        <Check className="size-3 shrink-0" aria-hidden />
        up to date
      </span>
    </div>
  );
}

// ─── Skeleton Card ────────────────────────────────────────────────────────────

function SkeletonCard({ index }: { index: number }) {
  return (
    <div
      className="catalog-card catalog-card-skeleton"
      style={{ animationDelay: `${index * 60}ms` }}
      aria-hidden
    >
      <div className="catalog-card-top">
        <div className="catalog-skeleton-icon" />
        <div className="catalog-skeleton-text">
          <div className="catalog-skeleton-line catalog-skeleton-name" />
          <div className="catalog-skeleton-line catalog-skeleton-tagline" />
        </div>
      </div>
      <div className="catalog-skeleton-chips">
        <div className="catalog-skeleton-chip" />
        <div className="catalog-skeleton-chip" style={{ width: "56px" }} />
        <div className="catalog-skeleton-chip" style={{ width: "48px" }} />
      </div>
    </div>
  );
}

// ─── Empty State ─────────────────────────────────────────────────────────────

function EmptyState({ search, scope }: { search: string; scope: Scope }) {
  return (
    <div className="catalog-empty">
      <div className="catalog-empty-icon" aria-hidden>
        <Search className="size-6 text-[#6B6B73]" />
      </div>
      <p className="catalog-empty-title">
        {scope === "installed" && !search
          ? "No apps installed yet"
          : search
          ? `No results for "${search}"`
          : "No apps in this category"}
      </p>
      <p className="catalog-empty-sub">
        {scope === "installed" && !search
          ? "Switch to All to browse the full catalog"
          : "Try a different search or category"}
      </p>
    </div>
  );
}
