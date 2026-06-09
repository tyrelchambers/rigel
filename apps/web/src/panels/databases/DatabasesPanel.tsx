import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Database, LoaderCircle, MonitorSmartphone } from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import type {
  CNPGCluster,
  CNPGScheduledBackup,
  DatabaseInstance,
  DatabasePod,
  DatabasePodRaw,
  WorkloadDB,
} from "./types";
import {
  buildInstances,
  connectionString,
  kindColorClass,
  matchPods,
  matchesDatabase,
  phaseDotClass,
  podNodes,
  readyColorClass,
  readyFraction,
  relativeAge,
  sourceBadgeLabel,
  walDotClass,
} from "./databasesDisplay";

// ---------------------------------------------------------------------------
// DEFERRED ACTIONS (docs/parity/databases.md §"Action block protocol"). This is
// a READ-ONLY panel. It emits NO action blocks and renders NO mutation buttons.
// All mutations come from chat action-blocks routed through the ConfirmSheet:
//   backupNow   → command args ["cnpg","backup",<cluster>,"-n",<ns>]
//   switchover  → command args ["cnpg","promote",<cluster>,<standby>,"-n",<ns>]
//   hibernate   → command args ["cnpg","maintenance","set",<cluster>,"-n",<ns>,"--reuse-pvc"]
//   resume      → command args ["cnpg","maintenance","unset",<cluster>,"-n",<ns>]
//   scale       → {"kind":"scale", ...} (reused from Workloads) or cnpg scale
//   portForward / revealCredentials → server endpoints (deferred)
//   copyDSN     → client-side string only (see connectionString)
// The CNPG-plugin button-state matrix is likewise deferred to chat.
// ---------------------------------------------------------------------------

/** Small muted chip (namespace etc.). */
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block rounded-full bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground">
      {children}
    </span>
  );
}

export default function DatabasesPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);

  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Watch CNPG CRDs + image-detected workloads + pods. CNPG cluster/backup CRDs
  // and the generic deployment/statefulset/pod watches all re-subscribe when the
  // namespace filter changes.
  useEffect(() => {
    const ns = namespaceFilter ?? "*";
    subscribe("clusters.postgresql.cnpg.io", ns);
    subscribe("scheduledbackups.postgresql.cnpg.io", ns);
    subscribe("deployments", ns);
    subscribe("statefulsets", ns);
    subscribe("pods", ns);
    return () => {
      unsubscribe("clusters.postgresql.cnpg.io", ns);
      unsubscribe("scheduledbackups.postgresql.cnpg.io", ns);
      unsubscribe("deployments", ns);
      unsubscribe("statefulsets", ns);
      unsubscribe("pods", ns);
    };
  }, [namespaceFilter]);

  // Rebuild the instance list only when the underlying resources change (the
  // store updates on every watch delta, not on any metrics poll).
  const instances = useMemo(
    () =>
      buildInstances({
        cnpgClusters: Object.values(
          (resources["clusters.postgresql.cnpg.io"] ?? {}) as Record<string, CNPGCluster>,
        ),
        scheduledBackups: Object.values(
          (resources["scheduledbackups.postgresql.cnpg.io"] ?? {}) as Record<
            string,
            CNPGScheduledBackup
          >,
        ),
        deployments: Object.values((resources["deployments"] ?? {}) as Record<string, WorkloadDB>),
        statefulSets: Object.values(
          (resources["statefulsets"] ?? {}) as Record<string, WorkloadDB>,
        ),
      }),
    [resources],
  );

  const pods = useMemo(
    () => Object.values((resources["pods"] ?? {}) as Record<string, DatabasePodRaw>),
    [resources],
  );

  const filtered = useMemo(
    () => instances.filter((i) => matchesDatabase(i, search)),
    [instances, search],
  );

  // Empty state: shown when there are no instances and no watch error. A failed
  // CNPG watch surfaces as the error banner (which never hides the list), so the
  // "no databases detected" empty state is only the genuine not-installed case.
  const showEmpty = !isLoading && instances.length === 0 && !error;

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Databases</h1>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground">
          {filtered.length}
        </span>
        {isLoading && (
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-label="loading" />
        )}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search databases…"
          className="ml-auto w-64 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      {/* Error banner — never hides the list. */}
      {error && (
        <pre className="rounded-md bg-destructive/10 px-3 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
          {error}
        </pre>
      )}

      {/* Empty state (CRD not installed AND nothing image-detected). */}
      {showEmpty && (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
          <Database className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">No databases detected</p>
          <p className="max-w-md text-xs text-muted-foreground">
            Nothing matched a known database operator CRD or a recognized database image.
          </p>
        </div>
      )}

      {/* Instance cards */}
      <div className="space-y-1.5">
        {filtered.map((inst) => (
          <DatabaseCard
            key={inst.id}
            instance={inst}
            pods={pods}
            expanded={expanded.has(inst.id)}
            onToggle={() => toggle(inst.id)}
          />
        ))}
      </div>

      {/* Filtered-to-zero (but instances exist) — keep it quiet. */}
      {!showEmpty && instances.length > 0 && filtered.length === 0 && (
        <p className="px-2 py-4 text-sm text-muted-foreground">No databases match search</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

function DatabaseCard({
  instance,
  pods,
  expanded,
  onToggle,
}: {
  instance: DatabaseInstance;
  pods: DatabasePodRaw[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const matchedPods = useMemo(() => matchPods(instance, pods), [instance, pods]);
  const nodes = podNodes(matchedPods);

  return (
    <div className="rounded-md border bg-card">
      {/* Collapsed row */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <ChevronRight
          className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${kindColorClass(instance.kind)}`}
        >
          {instance.kind}
        </span>
        <span className="truncate font-mono font-semibold" title={instance.name}>
          {instance.name}
        </span>
        <Chip>{instance.namespace}</Chip>
        <span className="rounded border px-1.5 py-0.5 text-[10px] font-mono uppercase text-muted-foreground">
          {sourceBadgeLabel(instance.source)}
        </span>

        {/* primary (CNPG only) */}
        {instance.source === "cnpg" && instance.cnpgPrimary && (
          <span className="truncate font-mono text-xs text-primary" title={instance.cnpgPrimary}>
            primary: {instance.cnpgPrimary}
          </span>
        )}

        {/* nodes */}
        {nodes.length > 0 && (
          <span className="flex items-center gap-1 truncate font-mono text-xs text-muted-foreground">
            {nodes.length > 1 && <MonitorSmartphone className="size-3 shrink-0" />}
            {nodes.join(", ")}
          </span>
        )}

        {/* ready/desired */}
        <span
          className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-xs font-mono ${readyColorClass(instance.isHealthy)}`}
        >
          {readyFraction(instance.readyReplicas, instance.desiredReplicas)}
        </span>
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="space-y-3 border-t px-3 py-3 text-sm">
          {/* IMAGE */}
          {instance.image && (
            <DetailRow label="IMAGE">
              <span className="font-mono text-xs break-all select-text">{instance.image}</span>
            </DetailRow>
          )}

          {/* STATUS */}
          <DetailRow label="STATUS">
            <span
              className={`text-xs ${instance.isHealthy ? "text-green-600 dark:text-green-400" : "text-foreground"}`}
            >
              {instance.phaseText}
            </span>
          </DetailRow>

          {/* AGE */}
          <DetailRow label="AGE">
            <span className="font-mono text-xs text-muted-foreground">
              {relativeAge(instance.creationTimestamp)}
            </span>
          </DetailRow>

          {/* PODS */}
          <PodsSection pods={matchedPods} />

          {/* CONNECT */}
          <DetailRow label="CONNECT">
            <span className="font-mono text-xs break-all select-text">
              {connectionString({
                kind: instance.kind,
                source: instance.source,
                target:
                  instance.source === "cnpg"
                    ? `${instance.name}-rw`
                    : (matchedPods[0]?.name ?? instance.name),
                namespace: instance.namespace,
              })}
            </span>
          </DetailRow>

          {/* BACKUPS & HEALTH (CNPG only) */}
          {instance.source === "cnpg" && <BackupsSection instance={instance} />}
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="w-32 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function PodsSection({ pods }: { pods: DatabasePod[] }) {
  return (
    <DetailRow label="PODS">
      {pods.length === 0 ? (
        <span className="text-xs text-muted-foreground/70">No matching pods</span>
      ) : (
        <ul className="space-y-1">
          {pods.map((p) => (
            <li key={p.name} className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground/60">├─</span>
              <span className="font-mono">{p.name}</span>
              <span className={`size-2 shrink-0 rounded-full ${phaseDotClass(p.phase)}`} />
              <span className="text-muted-foreground">{p.phase}</span>
              {p.isPrimary && (
                <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  primary
                </span>
              )}
              {p.node && (
                <span className="ml-auto font-mono text-muted-foreground">{p.node}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </DetailRow>
  );
}

function BackupsSection({ instance }: { instance: DatabaseInstance }) {
  const wal = instance.walArchiving ?? "unknown";
  return (
    <DetailRow label="BACKUPS & HEALTH">
      <div className="space-y-1 text-xs">
        <div className="flex gap-2">
          <span className="w-28 text-muted-foreground">Last backup</span>
          <span className="font-mono select-text">{instance.lastBackup ?? "never"}</span>
        </div>
        <div className="flex gap-2">
          <span className="w-28 text-muted-foreground">Schedule</span>
          <span className="font-mono select-text">
            {instance.scheduledBackup ?? "none configured"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-28 text-muted-foreground">WAL archiving</span>
          <span className={`size-2 shrink-0 rounded-full ${walDotClass(wal)}`} />
          <span>{wal}</span>
        </div>
      </div>
    </DetailRow>
  );
}
