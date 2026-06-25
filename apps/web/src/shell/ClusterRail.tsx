import { useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { useCluster } from "@/store/cluster";
import { useContexts, useDeleteCluster } from "@/lib/api";
import { initContext, switchCluster } from "@/lib/ws";
import { classifyProvider, providerLabel } from "./clusterTile";
import { CLUSTER_ICONS, type IconId } from "./clusterIcons";
import { loadIconOverrides, saveIconOverrides, resolveIconId } from "./clusterIconStore";
import { ClusterIconPicker } from "./ClusterIconPicker";
import { CreateClusterModal } from "./CreateClusterModal";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Full-height far-left rail of cluster tiles. Clicking a tile re-points the whole
 * app at that kubeconfig context. Single active cluster at a time. Shown whenever
 * there's at least one context; hidden only when the kubeconfig is empty.
 *
 * Each tile shows the provider-default icon (or a user override). Right-clicking
 * a tile opens the icon-picker modal; left-clicking switches the active cluster.
 */
export function ClusterRail() {
  const { data: contexts } = useContexts();
  const activeContext = useCluster((s) => s.activeContext);
  const [iconOverrides, setIconOverrides] = useState<Record<string, IconId>>(() => loadIconOverrides());
  // The context whose icon is being edited (null = picker closed).
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const deleteCluster = useDeleteCluster();

  // Once contexts load, adopt the kubeconfig's active one as the initial active
  // context (no teardown). initContext only acts while currentContext is unset.
  useEffect(() => {
    const initial = contexts?.find((c) => c.active) ?? contexts?.[0];
    if (initial) initContext(initial.name);
  }, [contexts]);

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
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-current={isActive ? "true" : undefined}
                        onClick={() => switchCluster(c.name)}
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
                          transition: "background 120ms ease, color 120ms ease",
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
                      <div style={{ color: "var(--accent-soft)", fontSize: 11 }}>{providerLabel(provider)}</div>
                      {c.server ? <div style={{ color: "var(--fg-secondary)", fontSize: 11 }}>{c.server}</div> : null}
                      <div style={{ color: "var(--fg-tertiary)", fontSize: 10, marginTop: 2 }}>Right-click to change icon</div>
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
          onClick={() => setCreateOpen(true)}
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
            deleteCluster.mutate(pickerFor);
            setPickerFor(null); // close the tile modal
          }
        }}
      />
      <CreateClusterModal open={createOpen} onOpenChange={setCreateOpen} />
    </nav>
  );
}
