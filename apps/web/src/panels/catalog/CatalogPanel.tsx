import { useEffect, useMemo, useState, type ReactNode } from "react";
import { motion, useAnimationControls } from "motion/react";
import {
  ArrowUp,
  Check,
  HelpCircle,
  RefreshCw,
  Search,
  Cpu,
  MemoryStick,
  HardDrive,
} from "lucide-react";
import { Loader } from "@/components/Loader";
import {
  APP_CATEGORIES,
  categoryDisplayName,
  installedAppIDs,
  loadCatalog,
  type AppCategory,
  type CatalogApp,
  type DeploymentLike,
  type StatefulSetLike,
  type DaemonSetLike,
  type PodLike,
} from "@rigel/catalog";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { useUpdates, type UpdateResult, type ActionBlock } from "@/lib/api";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { InfoTooltip } from "@/components/InfoTooltip";
import { iconFor } from "./icons";
import { boundAppID, boundContainer } from "@rigel/catalog";
import {
  availableCategories,
  filterCatalog,
  type Scope,
} from "./catalogDisplay";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { CatalogDetailSheet } from "./CatalogDetailSheet";
import { CatalogInstallWizard } from "./CatalogInstallWizard";
import { PurgeSheet } from "@/panels/purge/PurgeSheet";
import { updateTargets, withTag, type UpdateTarget } from "./updateTargets";
import { LinkWorkloadPickerSheet, type LinkSelection } from "./LinkWorkloadPickerSheet";

// Watches the catalog needs cluster-wide (detection scans every namespace) plus
// namespace/node lists for the wizard dropdowns.
const WATCHES: Array<[string, string]> = [
  ["deployments", "*"],
  ["statefulsets", "*"],
  ["daemonsets", "*"],
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
  // Node pin carried from the detail sheet into the wizard's Configure step.
  // null = "Any" (the default when launched straight from a card's Install).
  const [wizardNodePin, setWizardNodePin] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);
  // The app whose Link workload picker is open, if any.
  const [linkApp, setLinkApp] = useState<CatalogApp | null>(null);
  // The workload targeted by the uninstall→purge flow, if any. null = closed.
  const [purgeTarget, setPurgeTarget] = useState<{ name: string; namespace: string } | null>(null);

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
    () =>
      Object.values(
        (resources["deployments"] ?? {}) as Record<string, DeploymentLike>,
      ),
    [resources],
  );
  const statefulSets = useMemo(
    () =>
      Object.values(
        (resources["statefulsets"] ?? {}) as Record<string, StatefulSetLike>,
      ),
    [resources],
  );
  const daemonSets = useMemo(
    () =>
      Object.values(
        (resources["daemonsets"] ?? {}) as Record<string, DaemonSetLike>,
      ),
    [resources],
  );
  const pods = useMemo(
    () => Object.values((resources["pods"] ?? {}) as Record<string, PodLike>),
    [resources],
  );

  // Installed detection — pure, recomputed on every cache/catalog change.
  const installedIDs = useMemo(
    () => installedAppIDs(catalog, deployments, statefulSets, daemonSets, pods),
    [catalog, deployments, statefulSets, daemonSets, pods],
  );

  // Update targets — the running image + workload coordinates for each
  // installed app, so we can both check for updates and emit a setImage action.
  const targets = useMemo(
    () => updateTargets(catalog, deployments, statefulSets, daemonSets, pods),
    [catalog, deployments, statefulSets, daemonSets, pods],
  );
  const targetByApp = useMemo(() => {
    const m = new Map<string, UpdateTarget>();
    for (const t of targets) m.set(t.appID, t);
    return m;
  }, [targets]);

  // Explicit annotation bindings (appID → bound workload coords). Only these
  // show the "Unlink" affordance; image-matched apps are not bound. First in
  // scan order (deployments → statefulSets → daemonSets) wins.
  const boundByApp = useMemo(() => {
    const m = new Map<
      string,
      { kind: "deployment" | "statefulset" | "daemonset"; name: string; namespace: string; container: string | null }
    >();
    const add = (
      kind: "deployment" | "statefulset" | "daemonset",
      meta: { name?: string; namespace?: string; annotations?: Record<string, string> } | undefined,
    ) => {
      const id = boundAppID(meta);
      if (!id || !meta?.name || m.has(id)) return;
      m.set(id, {
        kind,
        name: meta.name,
        namespace: meta.namespace ?? "default",
        container: boundContainer(meta),
      });
    };
    for (const d of deployments) add("deployment", d.metadata);
    for (const s of statefulSets) add("statefulset", s.metadata);
    for (const ds of daemonSets) add("daemonset", ds.metadata);
    return m;
  }, [deployments, statefulSets, daemonSets]);

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
      resourceKind: target.workloadKind,
      container: target.container,
      image: withTag(target.image, latest),
    });
  }

  // Resolve a link picker selection → linkCatalogApp action through ConfirmSheet.
  function onLinkPicked(sel: LinkSelection) {
    setPendingAction({
      kind: "linkCatalogApp",
      label: `Link ${sel.kind}/${sel.name} to ${sel.appID}`,
      name: sel.name,
      namespace: sel.namespace,
      resourceKind: sel.kind,
      appID: sel.appID,
      ...(sel.container ? { container: sel.container } : {}),
    });
  }

  // Unlink the bound workload for an app → unlinkCatalogApp action.
  function onUnlink(
    appID: string,
    binding: { kind: "deployment" | "statefulset" | "daemonset"; name: string; namespace: string },
  ) {
    setPendingAction({
      kind: "unlinkCatalogApp",
      label: `Unlink ${binding.kind}/${binding.name} from ${appID}`,
      name: binding.name,
      namespace: binding.namespace,
      resourceKind: binding.kind,
    });
  }

  const namespaces = useMemo(
    () =>
      Object.values(
        (resources["namespaces"] ?? {}) as Record<string, NamedItem>,
      )
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

  const cats = useMemo(
    () => availableCategories(catalog, APP_CATEGORIES),
    [catalog],
  );

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
            <div className="flex items-center gap-2">
              <h1 className="catalog-title">Apps</h1>
              <InfoTooltip label="Install and manage cluster applications" />
            </div>
          </div>

          <div className="catalog-header-controls">
            {/* Scope segmented control */}
            <SegmentedTabs
              tabs={[
                { id: "all", label: "All" },
                { id: "installed", label: "Installed", badge: installedIDs.size },
              ]}
              active={scope}
              onChange={(id) => setScope(id as typeof scope)}
            />

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
                <Loader
                  size={12}
                  label="loading"
                  style={{ position: "absolute", right: 10, color: "var(--fg-tertiary)" }}
                />
              )}
            </div>
          </div>
        </div>

        {/* Category pill rail */}
        <div
          className="catalog-category-rail"
          role="group"
          aria-label="Filter by category"
        >
          <CategoryPill
            active={category === null}
            label="All"
            onClick={() => setCategory(null)}
          />
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
      {loadError && <pre className="catalog-error">{loadError}</pre>}

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
                onLink={() => setLinkApp(app)}
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
          binding={boundByApp.get(detailApp.id) ?? null}
          open
          onOpenChange={(open) => !open && setDetailApp(null)}
          onInstall={(nodePin) => {
            setWizardNodePin(nodePin);
            setWizardApp(detailApp);
            setDetailApp(null);
          }}
          onLink={() => {
            setLinkApp(detailApp);
            setDetailApp(null);
          }}
          onUnlink={() => {
            const b = boundByApp.get(detailApp.id);
            if (b) onUnlink(detailApp.id, b);
            setDetailApp(null);
          }}
          updateResult={(() => {
            const t = targetByApp.get(detailApp.id);
            return t ? (resultByImage.get(t.image) ?? null) : null;
          })()}
          onUpdate={(latest) => {
            const t = targetByApp.get(detailApp.id);
            if (t) onUpdate(t, latest);
            setDetailApp(null);
          }}
          onUninstall={(() => {
            // Uninstall targets the app's installed workload. Prefer the
            // explicit binding (name+namespace); else the image-matched
            // UpdateTarget. If neither resolves, leave undefined so the
            // Uninstall button disables rather than crashing.
            const b = boundByApp.get(detailApp.id);
            const t = targetByApp.get(detailApp.id);
            const target = b
              ? { name: b.name, namespace: b.namespace }
              : t
                ? { name: t.workloadName, namespace: t.namespace }
                : null;
            if (!target) return undefined;
            return () => {
              setDetailApp(null);
              setPurgeTarget(target);
            };
          })()}
        />
      )}

      {/* Link workload picker */}
      {linkApp && (
        <LinkWorkloadPickerSheet
          app={linkApp}
          open
          onClose={() => setLinkApp(null)}
          onPick={onLinkPicked}
        />
      )}

      {/* Install wizard */}
      {wizardApp && (
        <CatalogInstallWizard
          app={wizardApp}
          namespaces={namespaces}
          nodeNames={nodeNames}
          clusterIssuers={[]}
          initialNodePin={wizardNodePin}
          onClose={() => setWizardApp(null)}
        />
      )}

      {/* setImage confirm sheet for the [Update] button */}
      <ConfirmSheet
        action={pendingAction}
        open={!!pendingAction}
        onClose={() => setPendingAction(null)}
      />

      {/* Uninstall → typed-name purge confirm (from the Manage detail sheet) */}
      <PurgeSheet
        target={purgeTarget}
        open={purgeTarget !== null}
        onClose={() => setPurgeTarget(null)}
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

// Reveal batcher. Cards that scroll into view within the same short window form a
// "batch" and cascade relative to ONE ANOTHER — so the stagger tracks what's
// actually on screen, not a card's position in the full list. This fixes both
// failure modes of an index-based delay: bottom cards no longer wait ~2.5s, and
// the cascade size now scales with the viewport (a wide screen that shows 12 cards
// at once cascades all 12, a narrow one cascades fewer) instead of a fixed cap.
const REVEAL_BATCH_MS = 250; // entries within this window belong to the same wave
const revealBatch = { startedAt: -Infinity, count: 0 };

function nextRevealDelaySeconds(): number {
  const now = performance.now();
  if (now - revealBatch.startedAt > REVEAL_BATCH_MS) {
    revealBatch.startedAt = now;
    revealBatch.count = 0;
  }
  const position = revealBatch.count;
  revealBatch.count += 1;
  // Cap a single wave so an unusually tall viewport still finishes promptly.
  return Math.min(position, 12) * 0.04;
}

function CatalogCard({
  app,
  isInstalled,
  onSelect,
  onLink,
  children,
}: {
  app: CatalogApp;
  isInstalled: boolean;
  onSelect: () => void;
  onLink: () => void;
  children?: ReactNode;
}) {
  const Icon = iconFor(app.iconSystemName);
  const controls = useAnimationControls();

  return (
    <motion.article
      className="catalog-card"
      // Reveal as the card scrolls into view, so the fade plays whether the card
      // is above or below the fold. `once` keeps it from replaying on scroll-back.
      // The stagger delay is assigned at the moment the card ENTERS the viewport
      // (see nextRevealDelaySeconds) so cards revealed together cascade together.
      initial={{ opacity: 0, y: 10 }}
      animate={controls}
      viewport={{ once: true, margin: "0px 0px -40px 0px" }}
      onViewportEnter={() => {
        controls.start({
          opacity: 1,
          y: 0,
          transition: {
            duration: 0.28,
            ease: [0.2, 0, 0.2, 1],
            delay: nextRevealDelaySeconds(),
          },
        });
      }}
      aria-label={`${app.name} — ${app.tagline}`}
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
        <span
          className="catalog-chip catalog-chip-req"
          title={`CPU: ${app.requirements.cpuRequest}${app.requirements.cpuLimit ? ` → ${app.requirements.cpuLimit}` : ""}`}
        >
          <Cpu className="catalog-chip-icon" aria-hidden />
          {app.requirements.cpuRequest}
        </span>
        <span
          className="catalog-chip catalog-chip-req"
          title={`Memory: ${app.requirements.memoryRequest}${app.requirements.memoryLimit ? ` → ${app.requirements.memoryLimit}` : ""}`}
        >
          <MemoryStick className="catalog-chip-icon" aria-hidden />
          {app.requirements.memoryRequest}
        </span>
        {app.requirements.storageGiB != null && (
          <span
            className="catalog-chip catalog-chip-req"
            title={`Storage: ${app.requirements.storageGiB} GiB`}
          >
            <HardDrive className="catalog-chip-icon" aria-hidden />
            {app.requirements.storageGiB}Gi
          </span>
        )}
      </div>

      {/* Update status row (for installed apps) */}
      {children && <div className="catalog-card-update">{children}</div>}

      {/* "Already installed? Link it…" — only on not-installed cards (the app is
          running under a mirror/private image detection couldn't match). Sits
          above the action footer so the link is offered before the Install CTA. */}
      {!isInstalled && (
        <button
          type="button"
          className="catalog-link-affordance"
          onClick={(e) => {
            e.stopPropagation();
            onLink();
          }}
          aria-label={`Link ${app.name} to a running workload`}
        >
          Already installed? Link it…
        </button>
      )}

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
              onSelect();
            }}
            aria-label={`Install ${app.name}`}
          >
            Install
          </button>
        )}
      </div>
    </motion.article>
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
        <Loader size={11} label="" className="shrink-0" />
        <span>Checking for updates…</span>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="catalog-update-row catalog-update-dim">Not checked</div>
    );
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
          title={
            result.reason ?? "Could not determine an update for this image"
          }
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
