import { useEffect, useMemo, useState } from "react";
import { Lock, Plus, LayoutGrid } from "lucide-react";
import { readActiveContext, useCluster } from "@/store/cluster";
import { useContexts, useDeleteCluster, useDisconnectCluster, useClusterHealth } from "@/lib/api";
import { useEntitlement } from "./useEntitlement";
import { useUpgrade } from "./UpgradeContext";
import { initContext, switchCluster } from "@/lib/ws";
import { classifyProvider, isCloudProvider, providerLabel } from "./clusterTile";
import { CLUSTER_ICONS, type IconId } from "./clusterIcons";
import { loadIconOverrides, saveIconOverrides, resolveIconId } from "./clusterIconStore";
import { ClusterIconPicker } from "./ClusterIconPicker";
import { RemoveClusterDialog } from "./RemoveClusterDialog";
import { CreateClusterModal } from "./CreateClusterModal";
import { AddClusterChooser } from "./AddClusterChooser";
import { ConnectClusterModal } from "./ConnectClusterModal";
import { ClusterHealthBadge } from "./ClusterHealthBadge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";

/**
 * Full-height far-left rail of cluster tiles. Clicking a tile re-points the whole
 * app at that kubeconfig context. Single active cluster at a time. Shown whenever
 * there's at least one context; hidden only when the kubeconfig is empty.
 *
 * Each tile shows the provider-default icon (or a user override). Right-clicking
 * a tile opens the icon-picker modal; left-clicking switches the active cluster.
 */
export function ClusterRail({
  launcherOpen = false,
  onToggleLauncher,
}: {
  launcherOpen?: boolean;
  onToggleLauncher?: () => void;
} = {}) {
  const { data: contexts } = useContexts();
  const activeContext = useCluster((s) => s.activeContext);
  const { payload } = useEntitlement();
  const cloudUnlocked = !!payload?.cloudConnect;
  const { openUpgrade } = useUpgrade();
  const [iconOverrides, setIconOverrides] = useState<Record<string, IconId>>(() => loadIconOverrides());
  // The context whose icon is being edited (null = picker closed).
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [removeFor, setRemoveFor] = useState<string | null>(null);
  const deleteCluster = useDeleteCluster();
  const disconnect = useDisconnectCluster();

  // Probe only the ACTIVE cloud context; the badge surfaces an expired login.
  const active = contexts?.find((c) => c.name === activeContext) ?? null;
  const activeProvider = active ? classifyProvider(active) : "generic";
  const isCloud = isCloudProvider(activeProvider);
  const health = useClusterHealth(active?.name ?? null, activeProvider, isCloud);

  // Keep the active context valid against the live kubeconfig list. On first load
  // (activeContext null) adopt the kubeconfig's active context. If the active
  // context later disappears (disconnected, deleted, or edited externally),
  // re-point at a valid one so panels don't query a context that's gone.
  useEffect(() => {
    if (!contexts || contexts.length === 0) return;
    // While entitlement is unresolved (payload null) treat cloud contexts as
    // unknown, NOT locked — otherwise a Pro user is destructively redirected to
    // a local cluster in the window before entitlement resolves.
    const entitlementKnown = payload != null;
    const isLocked = (c: { name: string; server: string }) =>
      entitlementKnown && !cloudUnlocked && isCloudProvider(classifyProvider(c));
    const fallback =
      contexts.find((c) => c.active && !isLocked(c)) ??
      contexts.find((c) => !isLocked(c)) ??
      contexts.find((c) => c.active) ??
      contexts[0];
    if (activeContext === null) {
      const saved = readActiveContext();
      const savedCtx = saved ? contexts.find((c) => c.name === saved) : undefined;
      const target = savedCtx && !isLocked(savedCtx) ? savedCtx.name : fallback.name;
      initContext(fallback.name);
      if (target !== fallback.name) switchCluster(target);
    } else {
      const active = contexts.find((c) => c.name === activeContext);
      if (!active) {
        switchCluster(fallback.name);
      } else if (isLocked(active)) {
        const local = contexts.find((c) => !isLocked(c));
        if (local && local.name !== activeContext) switchCluster(local.name);
      }
    }
  }, [contexts, activeContext, cloudUnlocked, payload]);

  function setIcon(contextName: string, id: IconId) {
    setIconOverrides((prev) => {
      const next = { ...prev, [contextName]: id };
      saveIconOverrides(next);
      return next;
    });
  }

  // The current icon id of the context being edited, for the picker's highlight.
  const pickerCurrentId = useMemo(() => {
    if (!pickerFor || !contexts) return null;
    const ctx = contexts.find((c) => c.name === pickerFor);
    return ctx ? resolveIconId(ctx.name, classifyProvider(ctx), iconOverrides) : null;
  }, [pickerFor, contexts, iconOverrides]);

  // Show the rail whenever there's at least one context (the user wants the
  // active cluster visible even in a single-cluster setup); only a truly empty
  // list hides it.
  if (!contexts || contexts.length === 0) return null;

  return (
    <nav
      aria-label="Clusters"
      style={{
        width: 56, minWidth: 56, maxWidth: 56, height: "100%",
        background: "var(--surface-sunken)",
        borderRight: "1px solid var(--border-subtle)",
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}
    >
      <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "10px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
        <TooltipProvider delay={300}>
          {contexts.map((c) => {
            const isActive = c.name === activeContext;
            const provider = classifyProvider(c);
            const iconId = resolveIconId(c.name, provider, iconOverrides);
            const Icon = CLUSTER_ICONS[iconId].Component;
            const locked = isCloudProvider(provider) && !cloudUnlocked;
            return (
              <div
                key={c.name}
                style={{ position: "relative", width: "100%", display: "flex", justifyContent: "center", flexShrink: 0 }}
              >
                {/* Discord-style active indicator: a slim blue bar flush against
                    the rail's left edge, rounded on the right, centered on the
                    active tile. */}
                {isActive && (
                  <span
                    aria-hidden
                    style={{
                      position: "absolute", left: 0, top: "50%",
                      transform: "translateY(-50%)",
                      width: 4, height: 20, borderRadius: "0 3px 3px 0",
                      background: "var(--accent-primary)",
                    }}
                  />
                )}
                {locked && (
                  <span
                    aria-hidden
                    style={{
                      position: "absolute", top: -2, right: 4, zIndex: 2,
                      width: 15, height: 15, borderRadius: 999,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      background: "var(--surface-elevated)", border: "1px solid var(--border-strong)",
                    }}
                  >
                    <Lock size={9} style={{ color: "var(--fg-secondary)" }} />
                  </span>
                )}
                {isActive && isCloud && health.data?.authExpired ? (
                  <ClusterHealthBadge onReconnect={() => setConnectOpen(true)} />
                ) : null}
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-current={isActive ? "true" : undefined}
                        onClick={() => (locked ? openUpgrade() : switchCluster(c.name))}
                        // Right-click opens the icon-picker modal for this context.
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setPickerFor(c.name);
                        }}
                        style={{
                          width: 38, height: 38, borderRadius: 10,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          cursor: "pointer",
                          color: isActive ? "var(--fg-primary)" : "var(--fg-secondary)",
                          // Active tile uses the card gray (lighter); the blue
                          // moved to the left-edge indicator above.
                          background: isActive ? "var(--surface-elevated)" : "var(--surface-primary)",
                          border: "1px solid var(--border-subtle)",
                          opacity: locked ? 0.5 : 1,
                          transition: "background 120ms ease, color 120ms ease, opacity 120ms ease",
                        }}
                      >
                        <Icon size={18} />
                      </button>
                    }
                  />
                  <TooltipContent side="right">
                    {/* Stack vertically: the tooltip Popup is an inline-flex row,
                        so without this column the lines squish side-by-side. */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-start", textAlign: "left", lineHeight: 1.35 }}>
                      <div style={{ fontWeight: 600, color: "var(--fg-primary)" }}>{c.name}</div>
                      <div className="text-2xs" style={{ color: "var(--accent-soft)" }}>{providerLabel(provider)}</div>
                      {locked ? <div className="text-2xs" style={{ color: "var(--accent-primary)" }}>Pro — click to upgrade</div> : null}
                      {c.server ? <div className="text-2xs" style={{ color: "var(--fg-secondary)" }}>{c.server}</div> : null}
                      <div className="text-3xs" style={{ color: "var(--fg-tertiary)", marginTop: 2 }}>Right-click to change icon</div>
                    </div>
                  </TooltipContent>
                </Tooltip>
              </div>
            );
          })}
        </TooltipProvider>
        <button
          type="button"
          title="Add / create a cluster"
          onClick={() => setChooserOpen(true)}
          style={{
            width: 38, height: 38, borderRadius: 10, marginTop: 2, flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
            color: "var(--fg-secondary)", background: "var(--surface-primary)",
            border: "1px dashed var(--border-strong)",
          }}
        >
          <Plus size={18} />
        </button>
      </div>

      <div style={{ padding: "10px 0", display: "flex", justifyContent: "center", flexShrink: 0, borderTop: "1px solid var(--border-subtle)" }}>
        <button
          type="button"
          aria-label="Open navigation"
          aria-expanded={launcherOpen}
          title="Navigation (⌘/)"
          onClick={() => onToggleLauncher?.()}
          style={{
            width: 38, height: 38, borderRadius: 999,
            display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
            background: launcherOpen ? "#FFFFFF" : "transparent",
            border: launcherOpen ? "1px solid #FFFFFF" : "1px solid var(--border-strong)",
            transition: "background 120ms ease, border-color 120ms ease",
          }}
        >
          <LayoutGrid size={18} style={{ color: launcherOpen ? "#18181B" : "var(--fg-tertiary)" }} />
        </button>
      </div>

      <ClusterIconPicker
        contextName={pickerFor}
        currentId={pickerCurrentId}
        onPick={(id) => {
          if (pickerFor) setIcon(pickerFor, id);
          setPickerFor(null);
        }}
        onClose={() => setPickerFor(null)}
        deletable={!!pickerFor && (pickerFor.startsWith("kind-") || pickerFor.startsWith("k3d-"))}
        onDelete={() => {
          // TODO: upgrade to the app's Dialog confirm
          if (pickerFor && window.confirm(`Delete cluster "${pickerFor}"? This destroys the local cluster and removes its kubeconfig context.`)) {
            const ctx = pickerFor;
            deleteCluster.mutate(ctx, {
              onSuccess: (data) => {
                toast.success(`Cluster "${ctx}" deleted`, {
                  description: data.backupPath
                    ? `Kubeconfig backed up to ${data.backupPath}`
                    : "Your kubeconfig couldn't be backed up.",
                });
              },
              onError: (err) => {
                toast.error(`Couldn't delete "${ctx}"`, {
                  description: err instanceof Error ? err.message : String(err),
                });
              },
            });
            setPickerFor(null); // close the tile modal
          }
        }}
        removable={!!contexts?.find((c) => c.name === pickerFor)}
        onRemove={() => { setRemoveFor(pickerFor); setPickerFor(null); }}
      />
      <RemoveClusterDialog
        cluster={contexts?.find((c) => c.name === removeFor) ?? null}
        open={removeFor !== null}
        onOpenChange={(o) => { if (!o) setRemoveFor(null); }}
        busy={disconnect.isPending}
        onConfirm={() => {
          const removed = removeFor;
          if (!removed) return;
          disconnect.mutate(removed, {
            onSuccess: (data) => {
              toast.success(`Removed "${removed}" from Rigel`, {
                description: data.backupPath ? `Kubeconfig backed up to ${data.backupPath}` : undefined,
              });
              setRemoveFor(null);
            },
            onError: (err) => {
              toast.error(`Couldn't remove "${removed}"`, {
                description: err instanceof Error ? err.message : String(err),
              });
            },
          });
        }}
      />
      <AddClusterChooser
        open={chooserOpen}
        onOpenChange={setChooserOpen}
        onCreateLocal={() => { setChooserOpen(false); setCreateOpen(true); }}
        onConnectExisting={() => { setChooserOpen(false); setConnectOpen(true); }}
      />
      <CreateClusterModal open={createOpen} onOpenChange={setCreateOpen} />
      <ConnectClusterModal open={connectOpen} onOpenChange={setConnectOpen} />
    </nav>
  );
}
