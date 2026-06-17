/**
 * NavStrip — the collapsible grouped sidebar.
 * Mirrors NavStrip.swift / NavCollapseState.swift exactly:
 *   - First launch: every titled group collapsed.
 *   - Collapse state persists in localStorage (helmsman.nav.collapsed).
 *   - If the current route is in a collapsed group, auto-expand that group.
 */
import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router";
import {
  LayoutGrid,
  Sparkles,
  Layers,
  Box,
  Boxes,
  Gauge,
  Server,
  GitBranch,
  Signpost,
  Network,
  Database,
  KeyRound,
  FileText,
  HardDrive,
  ShieldCheck,
  BadgeCheck,
  Bell,
  ScrollText,
  SquareDashed,
  UserRoundKey,
  Settings,
  ChevronRight,
  ChevronDown,
  AppWindow,
  FilePlus2,
  SquareTerminal,
} from "lucide-react";
// Note: MessageSquare (chat) and Activity (health) are intentionally absent —
// chat is the always-visible right pane (not a route), and health is nav-hidden.
import type { LucideIcon } from "lucide-react";
import {
  loadCollapsed,
  saveCollapsed,
  toggle,
  isCollapsed,
  revealPanel,
  type NavCollapseState,
} from "./navCollapse";

// ─── Panel metadata ───────────────────────────────────────────────────────────

export interface PanelMeta {
  route: string;
  title: string;
  subtitle: string;
  icon: LucideIcon;
}

export const PANEL_META: Record<string, PanelMeta> = {
  overview:     { route: "/overview",     title: "Overview",     subtitle: "Health at a glance",    icon: LayoutGrid },
  assistant:    { route: "/assistant",    title: "Assistant",    subtitle: "AI cluster operator",   icon: Sparkles },
  deployments:  { route: "/deployments",  title: "Deployments",  subtitle: "Rollouts & replicas",   icon: Layers },
  pods:         { route: "/pods",         title: "Pods",         subtitle: "Running containers",    icon: Box },
  workloads:    { route: "/workloads",    title: "Workloads",    subtitle: "All controllers",       icon: Boxes },
  rightsizing:  { route: "/rightsizing",  title: "Right-sizing", subtitle: "Resource tuning",       icon: Gauge },
  services:     { route: "/services",     title: "Services",     subtitle: "Internal networking",   icon: Network },
  ingresses:    { route: "/ingresses",    title: "Ingresses",    subtitle: "External routing",      icon: Signpost },
  configmaps:   { route: "/configmaps",   title: "ConfigMaps",   subtitle: "App configuration",    icon: FileText },
  secrets:      { route: "/secrets",      title: "Secrets",      subtitle: "Sensitive config",      icon: KeyRound },
  storage:      { route: "/storage",      title: "Storage",      subtitle: "Volumes & claims",      icon: HardDrive },
  databases:    { route: "/databases",    title: "Databases",    subtitle: "Stateful stores",       icon: Database },
  namespaces:   { route: "/namespaces",   title: "Namespaces",   subtitle: "Logical partitions",    icon: SquareDashed },
  nodes:        { route: "/nodes",        title: "Nodes",        subtitle: "Cluster machines",      icon: Server },
  connectivity: { route: "/connectivity", title: "Connectivity", subtitle: "Traffic & reachability",icon: GitBranch },
  rbac:         { route: "/rbac",         title: "RBAC",         subtitle: "Access control",        icon: ShieldCheck },
  certificates: { route: "/certificates", title: "Certificates", subtitle: "TLS & cert-manager",    icon: BadgeCheck },
  events:       { route: "/events",       title: "Events",       subtitle: "Recent activity",       icon: Bell },
  logs:         { route: "/logs",         title: "Logs",         subtitle: "Container output",      icon: ScrollText },
  catalog:      { route: "/catalog",      title: "Apps",         subtitle: "Install apps",          icon: AppWindow },
  apply:        { route: "/apply",        title: "Apply YAML",   subtitle: "Create from manifest",  icon: FilePlus2 },
  terminal:     { route: "/terminal",     title: "Terminal",     subtitle: "Interactive shell",     icon: SquareTerminal },
  accounts:     { route: "/accounts",     title: "Accounts",     subtitle: "Registry credentials",  icon: UserRoundKey },
  settings:     { route: "/settings",     title: "Settings",     subtitle: "Preferences",           icon: Settings },
  // "chat" and "health" are intentionally omitted:
  //   chat   → always-visible right pane (ChatPane), not a route
  //   health → internal route kept registered but not shown in nav/palette
};

// ─── Nav groups (mirrors PanelKind.navGroups) ─────────────────────────────────

export interface NavGroup {
  title: string | null;
  panels: string[]; // panel keys
}

export const NAV_GROUPS: NavGroup[] = [
  { title: null, panels: ["overview", "assistant"] },
  { title: "Workloads", panels: ["deployments", "pods", "workloads", "rightsizing"] },
  { title: "Networking", panels: ["services", "ingresses"] },
  { title: "Config & Storage", panels: ["configmaps", "secrets", "storage", "databases"] },
  { title: "Cluster", panels: ["namespaces", "nodes", "connectivity", "rbac"] },
  { title: "Security & Certs", panels: ["certificates"] },
  { title: "Observability", panels: ["events", "logs"] },
  { title: "Self-host", panels: ["catalog"] },
  { title: "Tools", panels: ["terminal", "apply"] },
  { title: "System", panels: ["accounts", "settings"] },
];

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
        style={{ fontSize: "10px", color: "var(--fg-tertiary)", letterSpacing: "0.06em" }}
        className="font-semibold uppercase"
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

interface NavButtonProps {
  panelKey: string;
}

function NavButton({ panelKey }: NavButtonProps) {
  const meta = PANEL_META[panelKey];
  if (!meta) return null;
  const Icon = meta.icon;

  return (
    <NavLink
      to={meta.route}
      title={meta.title}
      className={({ isActive }) =>
        [
          "flex items-center gap-2.5 px-2.5 h-8 w-full rounded-md transition-colors group",
          isActive
            ? "nav-btn-active"
            : "nav-btn-idle hover:bg-[#1B1C1F]",
        ].join(" ")
      }
    >
      {({ isActive }) => (
        <>
          <Icon
            size={14}
            strokeWidth={isActive ? 2 : 1.75}
            style={{
              color: isActive ? "var(--accent-primary)" : "var(--fg-tertiary)",
              flexShrink: 0,
              width: 20,
            }}
            className={!isActive ? "group-hover:!text-[#A1A1AA]" : ""}
          />
          <span
            style={{
              fontSize: "13px",
              color: isActive ? "var(--fg-primary)" : "var(--fg-secondary)",
              fontWeight: isActive ? 600 : 500,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            className={!isActive ? "group-hover:!text-white" : ""}
          >
            {meta.title}
          </span>
        </>
      )}
    </NavLink>
  );
}

// ─── NavStrip ─────────────────────────────────────────────────────────────────

export default function NavStrip() {
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
      <nav
        style={{
          width: 200,
          minWidth: 200,
          maxWidth: 200,
          height: "100%",
          background: "var(--surface-primary)",
          borderRight: "1px solid var(--border-subtle)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
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
          {NAV_GROUPS.map((group) => {
            const groupKey = group.title ?? "_pinned";

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

            const collapsed = isCollapsed(collapseState, group.title);

            return (
              <div key={groupKey}>
                <NavGroupHeader
                  title={group.title}
                  collapsed={collapsed}
                  onToggle={() => handleToggle(group.title!)}
                />
                {!collapsed && (
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
    </>
  );
}
