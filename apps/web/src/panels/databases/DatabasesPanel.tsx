import { useEffect, useMemo, useState } from "react";
import { Database } from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { handoffToChat } from "@/lib/chatHandoff";
import { viewYaml } from "@/store/yamlViewer";
import { ListRow } from "@/panels/components/ListRow";
import { TagPill } from "@/panels/components/TagPill";
import { StatusBadge } from "@/panels/components/StatusBadge";
import { PanelHeader } from "@/panels/components/PanelHeader";
import { buildHandoffPrompt } from "@/panels/components/chatHandoffPrompts";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import {
  PortForwardDialog,
  type PortForwardTarget,
} from "@/panels/services/PortForwardDialog";
import { useForwards, useCnpgPluginAvailable, type ActionBlock } from "@/lib/api";
import type {
  CNPGBackup,
  CNPGCluster,
  CNPGScheduledBackup,
  ConnectionInfo,
  DatabaseAction,
  DatabaseCapabilities,
  DatabaseInstance,
  DatabasePod,
  DatabasePodRaw,
  DatabaseSecret,
  WorkloadDB,
} from "./types";
import {
  actionLabel,
  actionToBlock,
  buildInstances,
  capabilities,
  connectionString,
  dsn,
  matchPods,
  matchesDatabase,
  phaseBadgeVariant,
  podNodes,
  readyFraction,
  relativeAge,
  sourceBadgeLabel,
  walBadgeVariant,
} from "./databasesDisplay";

// ---------------------------------------------------------------------------
// Per-instance action bar (backup / switchover / hibernate / scale / port-
// forward / credentials / copy-DSN). Mutating actions route through the
// ConfirmSheet; port-forward / credentials / copy-DSN are handled in-UI.
// ---------------------------------------------------------------------------

export default function DatabasesPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);

  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data: cnpgPluginAvailable = false } = useCnpgPluginAvailable();
  const { data: activeForwards = [] } = useForwards();

  // Confirm-sheet + port-forward dialog state (panel-level so a collapsed row
  // still completes an in-flight flow).
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);
  const [pfTarget, setPfTarget] = useState<PortForwardTarget | null>(null);

  // Watch CNPG CRDs + image-detected workloads + pods + secrets.
  useEffect(() => {
    const ns = namespaceFilter ?? "*";
    subscribe("clusters.postgresql.cnpg.io", ns);
    subscribe("scheduledbackups.postgresql.cnpg.io", ns);
    subscribe("backups.postgresql.cnpg.io", ns);
    subscribe("deployments", ns);
    subscribe("statefulsets", ns);
    subscribe("pods", ns);
    subscribe("secrets", ns);
    return () => {
      unsubscribe("clusters.postgresql.cnpg.io", ns);
      unsubscribe("scheduledbackups.postgresql.cnpg.io", ns);
      unsubscribe("backups.postgresql.cnpg.io", ns);
      unsubscribe("deployments", ns);
      unsubscribe("statefulsets", ns);
      unsubscribe("pods", ns);
      unsubscribe("secrets", ns);
    };
  }, [namespaceFilter]);

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
        backups: Object.values(
          (resources["backups.postgresql.cnpg.io"] ?? {}) as Record<string, CNPGBackup>,
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

  // Raw resources needed for per-instance capability computation.
  const cnpgClusters = useMemo(
    () =>
      Object.values(
        (resources["clusters.postgresql.cnpg.io"] ?? {}) as Record<string, CNPGCluster>,
      ),
    [resources],
  );
  const scheduledBackups = useMemo(
    () =>
      Object.values(
        (resources["scheduledbackups.postgresql.cnpg.io"] ?? {}) as Record<
          string,
          CNPGScheduledBackup
        >,
      ),
    [resources],
  );
  const secrets = useMemo(
    () => Object.values((resources["secrets"] ?? {}) as Record<string, DatabaseSecret>),
    [resources],
  );

  const filtered = useMemo(
    () => instances.filter((i) => matchesDatabase(i, search)),
    [instances, search],
  );

  const showEmpty = !isLoading && instances.length === 0 && !error;

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function askClaude(inst: DatabaseInstance, topic: "Errors" | "Logs" | "Explain") {
    handoffToChat(buildHandoffPrompt(inst.kind, inst.name, inst.namespace, topic));
  }

  // Route an action-bar click. Mutating actions open the ConfirmSheet; the
  // non-mutating trio (port-forward / credentials / copy-DSN) is handled here.
  function handleAction(
    action: DatabaseAction,
    instance: DatabaseInstance,
    connection: ConnectionInfo | undefined,
  ) {
    switch (action.type) {
      case "portForward":
        if (connection) {
          setPfTarget({
            // The server's port-forward manager keys svc-vs-pod off targetKind,
            // passing the target name in the `service` field for both.
            service: connection.targetName,
            namespace: connection.namespace,
            remotePort: connection.port,
          });
        }
        return;
      case "copyDSN":
        if (connection) void navigator.clipboard.writeText(dsn(connection));
        return;
      case "revealCredentials":
        // Credentials are revealed inline in the detail section (no sheet).
        return;
      default: {
        const block = actionToBlock(action, instance);
        if (block) setPendingAction(block);
      }
    }
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Databases"
        subtitle="CNPG clusters & image-detected"
        count={filtered.length}
        loading={isLoading}
      >
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search databases…"
          className="w-56 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </PanelHeader>

      <div className="flex-1 overflow-auto">
        {/* Error banner — never hides the list. */}
        {error && (
          <pre className="bg-destructive/10 px-4 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
            {error}
          </pre>
        )}

        {/* Friendly empty state: no CNPG and nothing image-detected. */}
        {showEmpty && (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <Database className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium">No CloudNativePG clusters found</p>
            <p className="max-w-md text-xs text-muted-foreground">
              Install the CloudNativePG operator and create a Cluster resource, or deploy a
              workload with a recognized database image to see it here.
            </p>
          </div>
        )}

        {/* Row list */}
        <div className="flex flex-col gap-0.5 px-3 py-2">
        {filtered.map((inst) => {
          const isOpen = expanded.has(inst.id);
          const matchedPods = matchPods(inst, pods);
          const ready = readyFraction(inst.readyReplicas, inst.desiredReplicas);
          const readyVariant = inst.isHealthy ? "healthy" : "error";
          const caps = capabilities({
            instance: inst,
            pods,
            cnpgCluster: cnpgClusters.find(
              (c) =>
                c.metadata.name === inst.name &&
                (c.metadata.namespace ?? "default") === inst.namespace,
            ),
            scheduledBackups,
            secrets,
            cnpgPluginAvailable,
          });

          const enabledActions = caps.actions.filter((item) => item.enabled);
          // Map the detection source to the underlying k8s resource kind for the
          // YAML viewer: CNPG clusters are the CRD; image-detected instances are
          // their workload kind (deployment / statefulset).
          const viewKind =
            inst.source === "cnpg" ? "cluster.postgresql.cnpg.io" : inst.source;
          const rowMenu = (
            <>
              <ContextMenuItem onClick={() => askClaude(inst, "Errors")}>Ask Claude: Errors</ContextMenuItem>
              <ContextMenuItem onClick={() => askClaude(inst, "Logs")}>Ask Claude: Logs</ContextMenuItem>
              <ContextMenuItem onClick={() => askClaude(inst, "Explain")}>Ask Claude: Explain</ContextMenuItem>
              {enabledActions.length > 0 && <ContextMenuSeparator />}
              {enabledActions.map((item, i) => (
                <ContextMenuItem
                  key={`${item.action.type}-${i}`}
                  onClick={() => handleAction(item.action, inst, caps.connection)}
                >
                  {actionLabel(item.action)}
                </ContextMenuItem>
              ))}
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => viewYaml(viewKind, inst.name, inst.namespace)}>View YAML…</ContextMenuItem>
              <ContextMenuItem onClick={() => toggle(inst.id)}>{isOpen ? "Collapse" : "Manage…"}</ContextMenuItem>
            </>
          );

          return (
            <ListRow
              key={inst.id}
              rowKey={inst.id}
              isOpen={isOpen}
              onToggle={() => toggle(inst.id)}
              contextMenu={rowMenu}
              expandedContent={
                <DatabaseDetail
                  instance={inst}
                  matchedPods={matchedPods}
                  capabilities={caps}
                  secrets={secrets}
                  onAction={(a) => handleAction(a, inst, caps.connection)}
                />
              }
            >
              {/* Name */}
              <button
                type="button"
                onClick={() => toggle(inst.id)}
                className="shrink-0 font-mono text-xs font-medium leading-none hover:underline text-foreground"
              >
                {inst.name}
              </button>

              {/* Namespace chip */}
              <span
                style={{
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 10,
                  color: "var(--fg-tertiary)",
                  background: "var(--surface-sunken)",
                  padding: "1px 5px",
                  borderRadius: 4,
                  border: "1px solid #26272B",
                  whiteSpace: "nowrap",
                }}
              >
                {inst.namespace}
              </span>

              {/* Kind / source — purple TagPill */}
              <TagPill label={inst.source === "cnpg" ? `cnpg/${inst.kind}` : inst.kind} />

              {/* Ready badge */}
              <StatusBadge label={ready} variant={readyVariant} />

              {/* Phase text — dim */}
              <span
                style={{
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 10,
                  color: "var(--fg-tertiary)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  minWidth: 0,
                  flexShrink: 1,
                }}
              >
                {inst.phaseText}
              </span>

              {/* Image / version — dim */}
              {inst.image && (
                <span
                  title={inst.image}
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                    color: "var(--fg-tertiary)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                    flexShrink: 1,
                    maxWidth: "14rem",
                  }}
                >
                  {inst.image}
                </span>
              )}

              {/* Spacer */}
              <span className="flex-1" />
            </ListRow>
          );
        })}
      </div>

        {/* Filtered-to-zero (but instances exist) */}
        {!showEmpty && instances.length > 0 && filtered.length === 0 && (
          <p className="px-4 py-4 text-sm text-muted-foreground">No databases match search</p>
        )}
      </div>

      {/* Confirm sheet for mutating actions (backup / switchover / hibernate /
          resume / scale) — shows the exact kubectl command before running. */}
      <ConfirmSheet
        action={pendingAction}
        open={!!pendingAction}
        onClose={() => setPendingAction(null)}
      />

      {/* Port-forward dialog (reuses the Services flow). */}
      <PortForwardDialog
        target={pfTarget}
        activeForwards={activeForwards}
        onClose={() => setPfTarget(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expanded detail
// ---------------------------------------------------------------------------

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground w-28 shrink-0">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function DatabaseDetail({
  instance,
  matchedPods,
  capabilities: caps,
  secrets,
  onAction,
}: {
  instance: DatabaseInstance;
  matchedPods: DatabasePod[];
  capabilities: DatabaseCapabilities;
  secrets: DatabaseSecret[];
  onAction: (action: DatabaseAction) => void;
}) {
  const nodes = podNodes(matchedPods);
  const wal = instance.walArchiving ?? "unknown";
  const [showCreds, setShowCreds] = useState(false);

  const credSecret =
    caps.connection?.secretName != null
      ? secrets.find(
          (s) =>
            s.metadata.name === caps.connection!.secretName &&
            (s.metadata.namespace ?? "default") === instance.namespace,
        )
      : undefined;

  function handleClick(action: DatabaseAction) {
    if (action.type === "revealCredentials") setShowCreds((v) => !v);
    onAction(action);
  }

  return (
    // `db-detail-mono` (index.css) forces a TRUE monospace on every `font-mono`
    // value inside: the app's `font-mono` is mapped to the proportional Geist
    // (via @theme inline, so a runtime --font-mono override has no effect).
    <div className="db-detail-mono space-y-2">
      {/* ACTION BAR — above IMAGE. Disabled buttons show their reason as a
          tooltip (or no tooltip for silent-disabled image-detected actions). */}
      {caps.actions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {caps.actions.map((item, i) => (
            <button
              key={`${item.action.type}-${i}`}
              type="button"
              disabled={!item.enabled}
              onClick={item.enabled ? () => handleClick(item.action) : undefined}
              title={item.disabledReason ?? actionLabel(item.action)}
              className={
                "rounded-sm border px-2 py-1 font-mono text-[11px] font-medium transition-colors " +
                (item.enabled
                  ? "border-border bg-muted/40 text-foreground hover:bg-muted"
                  : "cursor-not-allowed border-border/50 bg-muted/20 text-muted-foreground/50")
              }
            >
              {actionLabel(item.action)}
            </button>
          ))}
        </div>
      )}

      {/* CREDENTIALS (inline reveal, toggled by the Credentials action). */}
      {showCreds && credSecret && (
        <DetailRow label="CREDENTIALS">
          <CredentialsReveal secret={credSecret} />
        </DetailRow>
      )}

      {/* IMAGE */}
      {instance.image && (
        <DetailRow label="IMAGE">
          <span className="font-mono text-xs break-all select-text text-muted-foreground">
            {instance.image}
          </span>
        </DetailRow>
      )}

      {/* SOURCE */}
      <DetailRow label="SOURCE">
        <span className="font-mono text-xs text-muted-foreground">
          {sourceBadgeLabel(instance.source)}
        </span>
      </DetailRow>

      {/* STATUS */}
      <DetailRow label="STATUS">
        <StatusBadge
          label={instance.phaseText}
          variant={instance.isHealthy ? "healthy" : "pending"}
          wrap
        />
      </DetailRow>

      {/* AGE */}
      <DetailRow label="AGE">
        <span className="font-mono text-xs text-muted-foreground">
          {relativeAge(instance.creationTimestamp)}
        </span>
      </DetailRow>

      {/* NODES */}
      {nodes.length > 0 && (
        <DetailRow label="NODES">
          <span className="font-mono text-xs text-muted-foreground">{nodes.join(", ")}</span>
        </DetailRow>
      )}

      {/* PODS */}
      <DetailRow label="PODS">
        {matchedPods.length === 0 ? (
          <span className="text-xs text-muted-foreground/70">No matching pods</span>
        ) : (
          <ul className="space-y-1">
            {matchedPods.map((p) => (
              <li key={p.name} className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground/60">├─</span>
                <span className="font-mono text-muted-foreground">{p.name}</span>
                <StatusBadge label={p.phase} variant={phaseBadgeVariant(p.phase)} />
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

      {/* CONNECT */}
      <DetailRow label="CONNECT">
        <span className="font-mono text-xs break-all select-text text-muted-foreground">
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

      {/* BACKUPS & WAL (CNPG only) */}
      {instance.source === "cnpg" && (
        <DetailRow label="BACKUPS & HEALTH">
          <div className="space-y-1 text-xs">
            <div className="flex gap-2">
              <span className="w-24 text-muted-foreground">Last backup</span>
              <span
                className="font-mono select-text text-muted-foreground"
                title={instance.lastBackup ?? undefined}
              >
                {instance.lastBackup ? `${relativeAge(instance.lastBackup)} ago` : "never"}
              </span>
            </div>
            <div className="flex gap-2">
              <span className="w-24 text-muted-foreground">Schedule</span>
              <span className="font-mono select-text text-muted-foreground">
                {instance.scheduledBackup ?? "none configured"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-24 text-muted-foreground">WAL archiving</span>
              <StatusBadge label={wal} variant={walBadgeVariant(wal)} />
            </div>
          </div>
        </DetailRow>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Credentials reveal — decodes the discovered secret's base64 values inline.
// Mirrors the SecretsPanel reveal (purely client-side base64 decode).
// ---------------------------------------------------------------------------

function decode(b64: string): string | null {
  try {
    return decodeURIComponent(escape(atob(b64)));
  } catch {
    return null;
  }
}

function CredentialsReveal({ secret }: { secret: DatabaseSecret }) {
  const entries = Object.entries(secret.data ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    return <span className="text-xs text-muted-foreground/70">No data keys</span>;
  }
  return (
    <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-0.5 text-xs font-mono">
      {entries.map(([k, v]) => {
        const value = decode(v);
        return (
          <div key={k} className="contents">
            <dt className="select-text text-muted-foreground">{k}</dt>
            <dd className="select-text break-all">
              {value == null ? <span className="text-muted-foreground/70">{`<binary>`}</span> : value}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
