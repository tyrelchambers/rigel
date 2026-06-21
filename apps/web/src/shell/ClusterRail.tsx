import { useEffect, useState } from "react";
import { useCluster } from "@/store/cluster";
import { useContexts } from "@/lib/api";
import { initContext, switchCluster } from "@/lib/ws";
import { classifyProvider, providerLabel } from "./clusterTile";
import { CLUSTER_ICONS, ICON_PALETTE, type IconId } from "./clusterIcons";
import { loadIconOverrides, saveIconOverrides, resolveIconId } from "./clusterIconStore";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuLabel } from "@/components/ui/context-menu";

/**
 * Full-height far-left rail of cluster tiles. Clicking a tile re-points the whole
 * app at that kubeconfig context. Single active cluster at a time. Hidden when
 * there's 0 or 1 context (no choice to make).
 *
 * Each tile shows the provider-default icon (or a user override). Right-clicking
 * opens an icon picker; left-clicking switches the active cluster.
 */
export function ClusterRail() {
  const { data: contexts } = useContexts();
  const activeContext = useCluster((s) => s.activeContext);
  const [iconOverrides, setIconOverrides] = useState<Record<string, IconId>>(() => loadIconOverrides());

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

  if (!contexts || contexts.length <= 1) return null;

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
              <ContextMenu key={c.name}>
                {/*
                 * ContextMenuTrigger wraps the whole Tooltip subtree so that
                 * right-clicking the button (or the trigger area) opens the icon
                 * picker. The Tooltip lives inside so hover still works on the
                 * same button element.
                 */}
                <ContextMenuTrigger>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          aria-current={isActive ? "true" : undefined}
                          onClick={() => switchCluster(c.name)}
                          style={{
                            width: 38, height: 38, borderRadius: 10,
                            display: "flex", alignItems: "center", justifyContent: "center",
                            cursor: "pointer",
                            color: isActive ? "var(--fg-primary)" : "var(--fg-secondary)",
                            background: isActive ? "var(--accent-primary)" : "var(--surface-primary)",
                            border: isActive ? "1px solid var(--accent-primary)" : "1px solid var(--border-subtle)",
                            transition: "background 120ms ease, color 120ms ease",
                          }}
                        >
                          <Icon size={18} />
                        </button>
                      }
                    />
                    <TooltipContent side="right">
                      <div style={{ fontWeight: 600 }}>{c.name}</div>
                      <div style={{ opacity: 0.8, fontSize: 11 }}>{providerLabel(provider)}</div>
                      {c.server ? <div style={{ opacity: 0.6, fontSize: 11 }}>{c.server}</div> : null}
                      <div style={{ opacity: 0.5, fontSize: 10, marginTop: 2 }}>Right-click to change icon</div>
                    </TooltipContent>
                  </Tooltip>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuLabel>Set icon</ContextMenuLabel>
                  {/*
                   * Each palette entry is a ContextMenuItem so base-ui closes
                   * the menu automatically on pick. The icon buttons are
                   * rendered inside ContextMenuItem via the render prop to
                   * keep them square and gridded.
                   */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 2, padding: 2 }}>
                    {ICON_PALETTE.map((id) => {
                      const P = CLUSTER_ICONS[id].Component;
                      const selected = id === iconId;
                      return (
                        <ContextMenuItem
                          key={id}
                          onClick={() => setIcon(c.name, id)}
                          title={CLUSTER_ICONS[id].label}
                          style={{
                            width: 30, height: 30, borderRadius: 6,
                            display: "flex", alignItems: "center", justifyContent: "center",
                            cursor: "pointer", padding: 0,
                            color: "var(--fg-primary)",
                            background: selected ? "var(--accent-primary)" : "transparent",
                            border: selected ? "1px solid var(--accent-primary)" : "1px solid transparent",
                          }}
                        >
                          <P size={16} />
                        </ContextMenuItem>
                      );
                    })}
                  </div>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </TooltipProvider>
      </div>
    </nav>
  );
}
