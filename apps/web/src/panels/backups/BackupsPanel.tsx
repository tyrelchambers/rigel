import { useEffect, useMemo, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faBoxArchive, faCamera, faDatabase, faStopwatch } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { filterByNamespace, useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { viewYaml } from "@/store/yamlViewer";
import { ListRow } from "@/panels/components/ListRow";
import { StatusBadge } from "@/panels/components/StatusBadge";
import { PanelHeader } from "@/panels/components/PanelHeader";
import { PanelSearch } from "@/panels/components/PanelSearch";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { KindAccessNotice } from "@/components/KindAccessNotice";
import { useCnpgPluginAvailable, type ActionBlock } from "@/lib/api";
import { actionToBlock, instanceFromCNPG, relativeAge, walBadgeVariant } from "@/panels/databases/databasesDisplay";
import type {
  CNPGBackup,
  CNPGCluster,
  CNPGScheduledBackup,
} from "@/panels/databases/types";
import type { BackupEvent, BackupGroup, BackupRow, VolumeSnapshot } from "./types";
import {
  backupsView,
  buildBackupGroups,
  eventBadgeVariant,
  filterGroups,
  fleetSummary,
  formatDuration,
  methodLabel,
  statusLabel,
  type FleetSummary,
} from "./backupsDisplay";

const BACKUPS_KIND = "backups.postgresql.cnpg.io";
const SNAPSHOTS_KIND = "volumesnapshots.snapshot.storage.k8s.io";
const CLUSTERS_KIND = "clusters.postgresql.cnpg.io";
const SCHEDULED_KIND = "scheduledbackups.postgresql.cnpg.io";
const OBJECTSTORES_KIND = "objectstores.barmancloud.cnpg.io";

const chipStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, monospace",
  color: "var(--fg-tertiary)",
  background: "var(--surface-sunken)",
  padding: "1px 6px",
  borderRadius: 4,
  border: "1px solid var(--border-subtle)",
  whiteSpace: "nowrap",
};

function InClusterBackupWarning({ resources }: { resources: Record<string, Record<string, unknown>> }) {
  const stores = Object.values((resources[OBJECTSTORES_KIND] ?? {}) as Record<string, { metadata?: { name?: string }; spec?: { configuration?: { endpointURL?: string } } }>);
  const inside = stores.filter((s) => /\.svc\.cluster\.local/i.test(s.spec?.configuration?.endpointURL ?? ""));
  if (inside.length === 0) return null;
  return (
    <div className="mx-4 mt-3 rounded-md border border-[var(--status-pending)] bg-[var(--surface-elevated)] px-3 py-2 text-xs text-[var(--fg-secondary)]">
      ObjectStore {inside.map((s) => s.metadata?.name).join(", ")} archives inside this cluster.
      A house outage takes the backups with it. Failover can dump with pg_dump if you accept that rewrite.
    </div>
  );
}

/** CNPG Backup runs in a group (excludes nested/standalone snapshots). */
function runCount(group: BackupGroup): number {
  return group.events.filter((e) => e.kind === "cnpgBackup").length;
}

export default function BackupsPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);
  const backupsAccess = useCluster((s) => s.accessByKind[BACKUPS_KIND]);
  const snapshotsAccess = useCluster((s) => s.accessByKind[SNAPSHOTS_KIND]);

  const [search, setSearch] = useState("");
  // Collapsed by default: a key is present only while its row is expanded.
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [openEvents, setOpenEvents] = useState<Set<string>>(new Set());
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);

  const { data: cnpgPluginAvailable = false } = useCnpgPluginAvailable();

  useEffect(() => {
    subscribe(CLUSTERS_KIND, "*");
    subscribe(SCHEDULED_KIND, "*");
    subscribe(BACKUPS_KIND, "*");
    subscribe(SNAPSHOTS_KIND, "*");
    subscribe(OBJECTSTORES_KIND, "*");
    return () => {
      unsubscribe(CLUSTERS_KIND, "*");
      unsubscribe(SCHEDULED_KIND, "*");
      unsubscribe(BACKUPS_KIND, "*");
      unsubscribe(SNAPSHOTS_KIND, "*");
      unsubscribe(OBJECTSTORES_KIND, "*");
    };
  }, []);

  const scheduledBackups = useMemo(
    () =>
      Object.values(
        (resources[SCHEDULED_KIND] ?? {}) as Record<string, CNPGScheduledBackup>,
      ),
    [resources],
  );
  const backups = useMemo(
    () =>
      filterByNamespace(
        resources[BACKUPS_KIND] as Record<string, CNPGBackup> | undefined,
        namespaceFilter,
      ),
    [resources, namespaceFilter],
  );

  const groups = useMemo(
    () =>
      buildBackupGroups({
        cnpgClusters: filterByNamespace(
          resources[CLUSTERS_KIND] as Record<string, CNPGCluster> | undefined,
          namespaceFilter,
        ),
        backups,
        snapshots: filterByNamespace(
          resources[SNAPSHOTS_KIND] as Record<string, VolumeSnapshot> | undefined,
          namespaceFilter,
        ),
        scheduledBackups,
      }),
    [resources, namespaceFilter, backups, scheduledBackups],
  );

  const filtered = useMemo(() => filterGroups(groups, search), [groups, search]);
  const summary = useMemo(() => fleetSummary(groups), [groups]);
  const view = backupsView({ isLoading, groups: filtered, backupsAccess, snapshotsAccess });

  function toggleGroup(key: string) {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function toggleEvent(id: string) {
    setOpenEvents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function backupNow(group: BackupGroup) {
    if (!group.cluster) return;
    const block = actionToBlock(
      { type: "backupNow" },
      instanceFromCNPG(group.cluster, scheduledBackups, backups),
    );
    if (block) setPendingAction(block);
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Backups"
        subtitle="Recent backups & snapshots"
        count={summary.databases}
        loading={isLoading}
      >
        <PanelSearch
          value={search}
          onValueChange={setSearch}
          placeholder="Filter by database, backup, or snapshot…"
          className="w-72"
        />
      </PanelHeader>

      <div className="flex-1 overflow-auto">
        <InClusterBackupWarning resources={resources} />
        {error && (
          <pre className="bg-destructive/10 px-4 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
            {error}
          </pre>
        )}

        {view.kind === "empty" && groups.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <FontAwesomeIcon icon={faBoxArchive} className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium">No backups or snapshots found</p>
            <p className="max-w-md text-xs text-muted-foreground">
              Runs appear here once CloudNativePG has taken a backup or a
              VolumeSnapshot has been created.
            </p>
          </div>
        )}

        {view.kind === "empty" && groups.length > 0 && (
          <p className="px-4 py-4 text-sm text-muted-foreground">No backups match search</p>
        )}

        {view.kind === "forbidden" &&
          view.forbiddenKinds.map((k) => (
            <KindAccessNotice key={k} kind={k} access={{ status: "forbidden" }} />
          ))}

        {view.kind === "list" && (
          <>
            <FleetStrip summary={summary} />
            <div className="flex flex-col gap-1.5 px-3 py-2">
              {view.groups.map((g) => (
                <BackupGroupRow
                  key={g.key}
                  group={g}
                  isOpen={openGroups.has(g.key)}
                  onToggle={() => toggleGroup(g.key)}
                  openEvents={openEvents}
                  onToggleEvent={toggleEvent}
                  cnpgPluginAvailable={cnpgPluginAvailable}
                  onBackupNow={() => backupNow(g)}
                />
              ))}
            </div>
          </>
        )}
      </div>

      <ConfirmSheet
        action={pendingAction}
        open={!!pendingAction}
        onClose={() => setPendingAction(null)}
      />
    </div>
  );
}

function FleetStrip({ summary }: { summary: FleetSummary }) {
  return (
    <div
      className="mx-3 mt-2 flex items-center gap-4 rounded-md border border-border px-4 py-2.5"
      style={{ background: "var(--surface-elevated)" }}
    >
      <Stat label="DATABASES" value={summary.databases} />
      <span className="h-4 w-px bg-border" />
      <Stat label="RUNS" value={summary.runs} />
      <Stat label="FAILING" value={summary.failing} tone={summary.failing > 0 ? "error" : "muted"} />
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "muted",
}: {
  label: string;
  value: number;
  tone?: "muted" | "error";
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-3xs uppercase tracking-[0.05em] text-muted-foreground">
        {label}
      </span>
      <span
        className={
          "font-mono text-sm font-semibold " +
          (tone === "error" ? "text-destructive" : "text-foreground")
        }
      >
        {value}
      </span>
    </div>
  );
}

function BackupGroupRow({
  group,
  isOpen,
  onToggle,
  openEvents,
  onToggleEvent,
  cnpgPluginAvailable,
  onBackupNow,
}: {
  group: BackupGroup;
  isOpen: boolean;
  onToggle: () => void;
  openEvents: Set<string>;
  onToggleEvent: (id: string) => void;
  cnpgPluginAvailable: boolean;
  onBackupNow: () => void;
}) {
  const isCnpg = group.kind === "cnpg";
  const canBackup = isCnpg && !!group.cluster && cnpgPluginAvailable;
  const runs = runCount(group);

  return (
    <ListRow
      rowKey={group.key}
      isOpen={isOpen}
      onToggle={onToggle}
      expandedContent={
        <div
          className="flex flex-col gap-1.5 rounded-md p-2"
          style={{ background: "var(--surface-sunken)" }}
        >
          {group.events.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground/70">No backups yet</p>
          ) : (
            group.events.map((e) => (
              <BackupEventRow
                key={e.id}
                event={e}
                isOpen={openEvents.has(e.id)}
                onToggle={() => onToggleEvent(e.id)}
              />
            ))
          )}
        </div>
      }
    >
      {isCnpg ? (
        <FontAwesomeIcon icon={faDatabase} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      ) : (
        <FontAwesomeIcon icon={faCamera} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <button
        type="button"
        onClick={onToggle}
        className="shrink-0 font-mono text-xs font-medium leading-none text-foreground hover:underline"
      >
        {group.title}
      </button>
      {group.namespace && (
        <span className="text-3xs" style={chipStyle}>
          {group.namespace}
        </span>
      )}
      {isCnpg && (
        <span className="flex items-center gap-1.5 text-3xs text-muted-foreground" title={group.lastBackup}>
          <span className="size-1.5 rounded-full bg-[var(--status-running)]" aria-hidden />
          {group.lastBackup ? `${relativeAge(group.lastBackup)} ago` : "never"}
        </span>
      )}
      <span className="text-3xs" style={chipStyle}>
        {isCnpg ? `${runs} runs` : `${group.events.length} snapshots`}
      </span>
      {isCnpg && group.wal && (
        <StatusBadge label={`WAL ${group.wal}`} variant={walBadgeVariant(group.wal)} />
      )}
      <span className="flex-1" />
      {isCnpg && (
        <button
          type="button"
          disabled={!canBackup}
          onClick={
            canBackup
              ? (e) => {
                  e.stopPropagation();
                  onBackupNow();
                }
              : undefined
          }
          title={canBackup ? "Back up now" : "cnpg plugin not available"}
          className={
            "rounded-sm border px-2 py-1 font-mono text-2xs font-medium transition-colors " +
            (canBackup
              ? "border-border bg-muted/40 text-foreground hover:bg-muted"
              : "cursor-not-allowed border-border/50 bg-muted/20 text-muted-foreground/50")
          }
        >
          Backup now
        </button>
      )}
    </ListRow>
  );
}

function BackupEventRow({
  event,
  isOpen,
  onToggle,
}: {
  event: BackupEvent;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const viewKind =
    event.kind === "cnpgBackup"
      ? "backup.postgresql.cnpg.io"
      : "volumesnapshot.snapshot.storage.k8s.io";
  const finishedIso = event.kind === "cnpgBackup" ? event.finishedAt : event.createdAt;
  const ageLabel = finishedIso ? `${relativeAge(finishedIso)} ago` : "—";

  const rowMenu = (
    <ContextMenuItem onClick={() => viewYaml(viewKind, event.name, event.namespace)}>
      View YAML…
    </ContextMenuItem>
  );

  return (
    <ListRow
      rowKey={event.id}
      isOpen={isOpen}
      onToggle={onToggle}
      contextMenu={rowMenu}
      expandedContent={<BackupEventDetail event={event} />}
    >
      <button
        type="button"
        onClick={onToggle}
        className="shrink-0 font-mono text-xs font-medium leading-none hover:underline text-foreground"
      >
        {event.name}
      </button>
      <StatusBadge label={statusLabel(event.status)} variant={eventBadgeVariant(event.status)} />
      {event.kind === "cnpgBackup" && (
        <span className="text-3xs" style={chipStyle}>{methodLabel(event.method)}</span>
      )}
      {event.kind === "volumeSnapshot" && event.sourcePvc && (
        <span className="text-3xs" style={chipStyle}>PVC: {event.sourcePvc}</span>
      )}
      <span className="flex-1" />
      {event.kind === "cnpgBackup" && event.durationSec !== undefined && (
        <>
          <span
            title="Duration"
            className="flex items-center gap-1 text-3xs"
            style={{ fontFamily: "ui-monospace, monospace", color: "var(--fg-tertiary)", whiteSpace: "nowrap" }}
          >
            <FontAwesomeIcon icon={faStopwatch} className="size-3 shrink-0" aria-hidden />
            {formatDuration(event.durationSec)}
          </span>
          <span className="text-3xs text-muted-foreground/50" aria-hidden>
            ·
          </span>
        </>
      )}
      <span
        title={event.kind === "cnpgBackup" ? "Finished" : "Created"}
        className="text-3xs"
        style={{ fontFamily: "ui-monospace, monospace", color: "var(--fg-tertiary)", whiteSpace: "nowrap" }}
      >
        {ageLabel}
      </span>
    </ListRow>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="text-3xs font-semibold uppercase tracking-[0.05em] text-muted-foreground w-28 shrink-0">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function BackupEventDetail({ event }: { event: BackupEvent }) {
  if (event.kind === "volumeSnapshot") {
    return (
      <div className="space-y-2 db-detail-mono">
        <DetailRow label="STATUS">
          <StatusBadge label={statusLabel(event.status)} variant={eventBadgeVariant(event.status)} wrap />
        </DetailRow>
        {event.sourcePvc && (
          <DetailRow label="SOURCE PVC">
            <span className="font-mono text-xs text-muted-foreground">{event.sourcePvc}</span>
          </DetailRow>
        )}
        {event.snapshotClass && (
          <DetailRow label="CLASS">
            <span className="font-mono text-xs text-muted-foreground">{event.snapshotClass}</span>
          </DetailRow>
        )}
        {event.restoreSize && (
          <DetailRow label="SIZE">
            <span className="font-mono text-xs text-muted-foreground">{event.restoreSize}</span>
          </DetailRow>
        )}
        <DetailRow label="CREATED">
          <span className="font-mono text-xs text-muted-foreground">{event.createdAt ?? "—"}</span>
        </DetailRow>
      </div>
    );
  }

  const b: BackupRow = event;
  return (
    <div className="space-y-2 db-detail-mono">
      <DetailRow label="METHOD">
        <span className="font-mono text-xs text-muted-foreground">{methodLabel(b.method)}</span>
      </DetailRow>
      <DetailRow label="STARTED">
        <span className="font-mono text-xs text-muted-foreground">{b.startedAt ?? "—"}</span>
      </DetailRow>
      <DetailRow label="FINISHED">
        <span className="font-mono text-xs text-muted-foreground">{b.finishedAt ?? "—"}</span>
      </DetailRow>
      <DetailRow label="DURATION">
        <span className="font-mono text-xs text-muted-foreground">{formatDuration(b.durationSec)}</span>
      </DetailRow>
      {(b.beginWal || b.endWal) && (
        <DetailRow label="WAL RANGE">
          <span className="font-mono text-xs break-all select-text text-muted-foreground">
            {b.beginWal ?? "?"} → {b.endWal ?? "?"}
          </span>
        </DetailRow>
      )}
      {b.snapshots.length > 0 && (
        <DetailRow label="SNAPSHOTS">
          <ul className="space-y-1">
            {b.snapshots.map((s) => (
              <li key={s.name} className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground/60">├─</span>
                <span className="font-mono text-muted-foreground">{s.name}</span>
                <StatusBadge label={s.ready ? "ready" : "not ready"} variant={s.ready ? "healthy" : "pending"} />
              </li>
            ))}
          </ul>
        </DetailRow>
      )}
    </div>
  );
}
