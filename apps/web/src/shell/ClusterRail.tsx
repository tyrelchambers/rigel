import { useEffect } from "react";
import { useCluster } from "@/store/cluster";
import { useContexts } from "@/lib/api";
import { initContext, switchCluster } from "@/lib/ws";
import { tileInitials } from "./clusterTile";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Full-height far-left rail of cluster tiles. Clicking a tile re-points the whole
 * app at that kubeconfig context. Single active cluster at a time. Hidden when
 * there's 0 or 1 context (no choice to make).
 */
export function ClusterRail() {
  const { data: contexts } = useContexts();
  const activeContext = useCluster((s) => s.activeContext);

  // Once contexts load, adopt the kubeconfig's active one as the initial active
  // context (no teardown). initContext only acts while currentContext is unset.
  useEffect(() => {
    const initial = contexts?.find((c) => c.active) ?? contexts?.[0];
    if (initial) initContext(initial.name);
  }, [contexts]);

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
            return (
              <Tooltip key={c.name}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-current={isActive ? "true" : undefined}
                      onClick={() => switchCluster(c.name)}
                      style={{
                        width: 38, height: 38, borderRadius: 10,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 12, fontWeight: 600, cursor: "pointer",
                        color: isActive ? "var(--fg-primary)" : "var(--fg-secondary)",
                        background: isActive ? "var(--accent-primary)" : "var(--surface-primary)",
                        border: isActive ? "1px solid var(--accent-primary)" : "1px solid var(--border-subtle)",
                        transition: "background 120ms ease, color 120ms ease",
                      }}
                    >
                      {tileInitials(c.name)}
                    </button>
                  }
                />
                <TooltipContent side="right">
                  <div style={{ fontWeight: 600 }}>{c.name}</div>
                  {c.server ? <div style={{ opacity: 0.7, fontSize: 11 }}>{c.server}</div> : null}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </TooltipProvider>
      </div>
    </nav>
  );
}
