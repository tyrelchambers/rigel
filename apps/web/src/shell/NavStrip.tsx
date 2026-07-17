/**
 * NavStrip — the collapsible grouped sidebar.
 * Mirrors NavStrip.swift / NavCollapseState.swift exactly:
 *   - First launch: every titled group collapsed.
 *   - Collapse state persists in localStorage (rigel.nav.collapsed).
 *   - If the current route is in a collapsed group, auto-expand that group.
 */
import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ChevronRight, ChevronDown } from "lucide-react";
import {
  loadCollapsed,
  saveCollapsed,
  toggle,
  isCollapsed,
  revealPanel,
  type NavCollapseState,
} from "./navCollapse";
import { PANEL_META, NAV_GROUPS } from "./navModel";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract the panel key from a pathname like "/deployments" → "deployments". */
function routeToPanelKey(pathname: string): string {
  return pathname.replace(/^\//, "").split("/")[0] ?? "overview";
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface NavGroupHeaderProps {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
}

function NavGroupHeader({ title, collapsed, onToggle }: NavGroupHeaderProps) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center justify-between px-3 pt-3.5 pb-0.5 cursor-pointer hover:opacity-80 transition-opacity"
      title={collapsed ? `Expand ${title}` : `Collapse ${title}`}
    >
      <span
        style={{ color: "var(--fg-tertiary)", letterSpacing: "0.06em" }}
        className="font-semibold uppercase text-3xs"
      >
        {title}
      </span>
      {collapsed ? (
        <ChevronRight size={10} style={{ color: "var(--fg-tertiary)" }} strokeWidth={2.5} />
      ) : (
        <ChevronDown size={10} style={{ color: "var(--fg-tertiary)" }} strokeWidth={2.5} />
      )}
    </button>
  );
}

type NavButtonProps = {
  panelKey: string;
  /** Icon-only rail mode: hide the label, center the icon. */
  collapsed?: boolean;
};

function NavButton({ panelKey, collapsed = false }: NavButtonProps) {
  const meta = PANEL_META[panelKey];
  if (!meta) return null;
  const Icon = meta.icon;

  const link = (
    <NavLink
      to={meta.route}
      aria-label={meta.title}
      className={({ isActive }) =>
        [
          collapsed
            ? "flex items-center justify-center h-8 w-full rounded-md transition-colors group"
            : "flex items-center gap-2.5 px-2.5 h-8 w-full rounded-md transition-colors group",
          isActive
            ? "nav-btn-active"
            : "nav-btn-idle hover:bg-[#1B1C1F]",
        ].join(" ")
      }
    >
      {({ isActive }) => (
        <>
          <Icon
            size={17}
            strokeWidth={isActive ? 2 : 1.75}
            style={{
              color: isActive ? "var(--accent-primary)" : "var(--fg-tertiary)",
              flexShrink: 0,
              width: 22,
            }}
            className={!isActive ? "group-hover:!text-[#A1A1AA]" : ""}
          />
          {!collapsed && (
            <span
              style={{
                color: isActive ? "var(--fg-primary)" : "var(--fg-secondary)",
                fontWeight: isActive ? 600 : 500,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
              className={`text-xs ${!isActive ? "group-hover:!text-white" : ""}`}
            >
              {meta.title}
            </span>
          )}
        </>
      )}
    </NavLink>
  );

  // Only the collapsed icon-only rail needs a tooltip; the expanded rail shows
  // the label inline already.
  if (!collapsed) return link;

  return (
    <Tooltip>
      <TooltipTrigger render={link} />
      <TooltipContent side="right" sideOffset={8}>
        {meta.title}
      </TooltipContent>
    </Tooltip>
  );
}

// ─── NavStrip ─────────────────────────────────────────────────────────────────

export default function NavStrip({
  collapsed = false,
}: {
  collapsed?: boolean;
}) {
  const location = useLocation();
  const activePanelKey = routeToPanelKey(location.pathname);

  const [collapseState, setCollapseState] = useState<NavCollapseState>(() =>
    loadCollapsed(),
  );

  // Auto-expand the group that contains the active route whenever the route changes.
  useEffect(() => {
    setCollapseState((prev) => {
      const next = revealPanel(prev, activePanelKey);
      if (next !== prev) {
        saveCollapsed(next);
      }
      return next;
    });
  }, [activePanelKey]);

  function handleToggle(title: string) {
    setCollapseState((prev) => {
      const next = toggle(prev, title);
      saveCollapsed(next);
      return next;
    });
  }

  return (
    <>
      {/* Inject the selected-state background as a style so Tailwind doesn't purge it */}
      <style>{`
        .nav-btn-active {
          background-color: rgba(56, 189, 248, 0.15);
        }
      `}</style>
      <TooltipProvider delay={0}>
      <nav
        style={{
          width: collapsed ? 52 : 200,
          minWidth: collapsed ? 52 : 200,
          maxWidth: collapsed ? 52 : 200,
          height: "100%",
          background: "var(--surface-primary)",
          borderRight: "1px solid var(--border-subtle)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          transition: "width 150ms ease, min-width 150ms ease, max-width 150ms ease",
        }}
      >
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            overflowX: "hidden",
            paddingTop: 12,
            paddingBottom: 12,
            paddingLeft: 8,
            paddingRight: 8,
          }}
        >
          {NAV_GROUPS.map((group, groupIdx) => {
            const groupKey = group.title ?? "_pinned";

            // ── Icon-only rail: render every panel as an icon, hide the titled
            // group headers, and keep visual separation with a thin divider.
            if (collapsed) {
              return (
                <div key={groupKey}>
                  {group.title && groupIdx > 0 && (
                    <div
                      style={{
                        height: 1,
                        margin: "8px 6px",
                        background: "var(--border-subtle)",
                      }}
                    />
                  )}
                  <div className="space-y-0.5">
                    {group.panels.map((p) => (
                      <NavButton key={p} panelKey={p} collapsed />
                    ))}
                  </div>
                </div>
              );
            }

            if (!group.title) {
              // Pinned group — always visible, no header
              return (
                <div key={groupKey} className="space-y-0.5">
                  {group.panels.map((p) => (
                    <NavButton key={p} panelKey={p} />
                  ))}
                </div>
              );
            }

            const groupCollapsed = isCollapsed(collapseState, group.title);

            return (
              <div key={groupKey}>
                <NavGroupHeader
                  title={group.title}
                  collapsed={groupCollapsed}
                  onToggle={() => handleToggle(group.title!)}
                />
                {!groupCollapsed && (
                  <div className="mt-0.5 space-y-0.5">
                    {group.panels.map((p) => (
                      <NavButton key={p} panelKey={p} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </nav>
      </TooltipProvider>
    </>
  );
}
