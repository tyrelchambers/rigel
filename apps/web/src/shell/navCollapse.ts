/**
 * Pure nav-collapse state — no React, no localStorage access.
 * Mirrors NavCollapseState.swift: a set of collapsed group titles,
 * serialised as a comma-joined string for persistence.
 *
 * The localStorage key used by NavStrip is exported so both the
 * component and the tests agree on it.
 */
export const NAV_COLLAPSE_KEY = "rigel.nav.collapsed";

/** All titled nav-group titles, in sidebar order. */
export const ALL_GROUP_TITLES = [
  "Workloads",
  "Networking",
  "Config & Storage",
  "Cluster",
  "Observability",
  "Self-host",
  "System",
] as const;

export type GroupTitle = (typeof ALL_GROUP_TITLES)[number];

/**
 * Map from panel route → group title (so we can auto-expand when the active
 * route lives in a collapsed group).
 */
const PANEL_GROUP: Record<string, GroupTitle> = {
  deployments:  "Workloads",
  pods:         "Workloads",
  workloads:    "Workloads",
  rightsizing:  "Workloads",
  services:     "Networking",
  ingresses:    "Networking",
  configmaps:   "Config & Storage",
  secrets:      "Config & Storage",
  storage:      "Config & Storage",
  databases:    "Config & Storage",
  namespaces:   "Cluster",
  nodes:        "Cluster",
  connectivity: "Cluster",
  rbac:         "Cluster",
  events:       "Observability",
  logs:         "Observability",
  catalog:      "Self-host",
  accounts:     "System",
  settings:     "System",
};

// ─── NavCollapseState ────────────────────────────────────────────────────────

export interface NavCollapseState {
  collapsed: ReadonlySet<string>;
}

/** Parse a comma-joined storage string → state. Blank segments are dropped. */
export function fromStorage(raw: string): NavCollapseState {
  const collapsed = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return { collapsed };
}

/** Serialise state → comma-joined string for localStorage. */
export function toStorage(state: NavCollapseState): string {
  return [...state.collapsed].sort().join(",");
}

/** First-launch default: every titled group is collapsed. */
export function defaultCollapsed(): NavCollapseState {
  return { collapsed: new Set(ALL_GROUP_TITLES) };
}

export function isCollapsed(state: NavCollapseState, title: string): boolean {
  return state.collapsed.has(title);
}

export function toggle(state: NavCollapseState, title: string): NavCollapseState {
  const next = new Set(state.collapsed);
  if (next.has(title)) {
    next.delete(title);
  } else {
    next.add(title);
  }
  return { collapsed: next };
}

/**
 * Ensure the group containing `panelRoute` is expanded so the active nav item
 * is visible. No-op for the pinned (title-less) group.
 */
export function revealPanel(state: NavCollapseState, panelRoute: string): NavCollapseState {
  const groupTitle = PANEL_GROUP[panelRoute];
  if (!groupTitle || !state.collapsed.has(groupTitle)) return state;
  const next = new Set(state.collapsed);
  next.delete(groupTitle);
  return { collapsed: next };
}

// ─── localStorage helpers ────────────────────────────────────────────────────

/** Load from localStorage; returns first-launch default if key is absent. */
export function loadCollapsed(): NavCollapseState {
  try {
    const raw = localStorage.getItem(NAV_COLLAPSE_KEY);
    if (raw === null) return defaultCollapsed();
    return fromStorage(raw);
  } catch {
    return defaultCollapsed();
  }
}

/** Persist state to localStorage. */
export function saveCollapsed(state: NavCollapseState): void {
  try {
    localStorage.setItem(NAV_COLLAPSE_KEY, toStorage(state));
  } catch {
    // ignore quota / private-browsing errors
  }
}

// ─── Sidebar collapse (icon-only rail) ───────────────────────────────────────
// Separate from the per-group collapse above: this is the whole-sidebar
// collapsed/expanded toggle driven by the GlobalHeader.

export const SIDEBAR_COLLAPSE_KEY = "rigel.sidebar.collapsed";

/** Load the whole-sidebar collapsed flag; defaults to expanded (false). */
export function loadSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === "true";
  } catch {
    return false;
  }
}

/** Persist the whole-sidebar collapsed flag as "true"/"false". */
export function saveSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSE_KEY, collapsed ? "true" : "false");
  } catch {
    // ignore quota / private-browsing errors
  }
}
