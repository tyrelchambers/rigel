# Nav Launcher Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the persistent 200px nav strip with an on-demand grid launcher popover opened from a circular button in the cluster rail or via ⌘/ (Ctrl+/), with search, a Favorites section, and category grids.

**Architecture:** Extract the nav data model (`PANEL_META` / `NAV_GROUPS`) into its own module so it survives the strip's deletion. Add pure logic modules for favorites persistence and grid building (arrow-key indexing, filtering, grouping) so behavior is unit-tested without React. Add a `NavLauncher` popover + `useNavLauncher()` hook mirroring the existing `useCommandPalette()` pattern. The circular trigger lives at the bottom of `ClusterRail`; `App.tsx` owns the open state and wires both. Remove the `NavStrip` component and the now-dead per-group / whole-sidebar collapse code.

**Tech Stack:** React 19, Vite, TypeScript, React Router v7, Tailwind v4, lucide-react, Vitest (jsdom). Path alias `@/` → `apps/web/src`. All commands run from `apps/web` unless noted.

---

## File Structure

New:
- `apps/web/src/shell/navModel.ts` — nav data model: `NavIcon`, `PanelMeta`, `PANEL_META`, `NavGroup`, `NAV_GROUPS`. Moved verbatim out of `NavStrip.tsx`.
- `apps/web/src/shell/navFavorites.ts` — favorites persistence (`localStorage`), pure + IO helpers.
- `apps/web/src/shell/navFavorites.test.ts` — tests for the above.
- `apps/web/src/shell/navLauncherLogic.ts` — pure grid logic: build groups/favorites cells, filter, arrow-key index math.
- `apps/web/src/shell/navLauncherLogic.test.ts` — tests for the above.
- `apps/web/src/shell/NavLauncher.tsx` — the popover overlay, the co-located `LaunchCell`, and the `useNavLauncher()` hook.

Modified:
- `apps/web/src/shell/CommandPalette.tsx` — import `PANEL_META` / `NAV_GROUPS` from `navModel` instead of `NavStrip`.
- `apps/web/src/shell/ClusterRail.tsx` — add the bottom circular launcher button + `launcherOpen` / `onToggleLauncher` props.
- `apps/web/src/App.tsx` — mount `<NavLauncher>`, own launcher state via `useNavLauncher()`, drop `<NavStrip>`, remove whole-sidebar collapse state.
- `apps/web/src/shell/GlobalHeader.tsx` — remove the sidebar collapse toggle button + its two props.

Removed:
- `apps/web/src/shell/NavStrip.tsx`
- `apps/web/src/shell/navCollapse.ts`
- `apps/web/src/shell/navCollapse.test.ts`

---

## Task 1: Extract the nav data model into `navModel.ts`

Moving `PANEL_META` / `NAV_GROUPS` out of `NavStrip.tsx` so they survive when the strip is deleted. `NavStrip.tsx` keeps working by importing them back (it is deleted in Task 7).

**Files:**
- Create: `apps/web/src/shell/navModel.ts`
- Modify: `apps/web/src/shell/NavStrip.tsx:11-126` (remove the moved declarations, import them instead)
- Modify: `apps/web/src/shell/CommandPalette.tsx:9`

- [ ] **Step 1: Create `navModel.ts` with the moved model**

Create `apps/web/src/shell/navModel.ts`:

```ts
import type { ComponentType, CSSProperties } from "react";
import {
  LayoutGrid, Layers, Box, Boxes, Gauge, Server, GitBranch, Signpost,
  Network, Database, DatabaseBackup, KeyRound, FileText, HardDrive,
  ShieldCheck, BadgeCheck, Bell, ScrollText, SquareDashed, UserRoundKey,
  Settings, AppWindow, FilePlus2, FileInput, Package, Puzzle,
} from "lucide-react";
import { RigelMark } from "@/components/RigelMark";

/**
 * Nav icons are usually lucide icons, but the Assistant uses the Rigel mark.
 * Both accept this prop shape, so PanelMeta.icon is typed to the common surface.
 */
export type NavIcon = ComponentType<{
  size?: number;
  strokeWidth?: number;
  style?: CSSProperties;
  className?: string;
}>;

export interface PanelMeta {
  route: string;
  title: string;
  subtitle: string;
  icon: NavIcon;
}

export const PANEL_META: Record<string, PanelMeta> = {
  overview:     { route: "/overview",     title: "Overview",     subtitle: "Health at a glance",    icon: LayoutGrid },
  assistant:    { route: "/assistant",    title: "Assistant",    subtitle: "AI cluster operator",   icon: RigelMark },
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
  backups:      { route: "/backups",      title: "Backups",      subtitle: "Snapshots & backups",   icon: DatabaseBackup },
  namespaces:   { route: "/namespaces",   title: "Namespaces",   subtitle: "Logical partitions",    icon: SquareDashed },
  nodes:        { route: "/nodes",        title: "Nodes",        subtitle: "Cluster machines",      icon: Server },
  connectivity: { route: "/connectivity", title: "Connectivity", subtitle: "Traffic & reachability",icon: GitBranch },
  rbac:         { route: "/rbac",         title: "RBAC",         subtitle: "Access control",        icon: ShieldCheck },
  certificates: { route: "/certificates", title: "Certificates", subtitle: "TLS & cert-manager",    icon: BadgeCheck },
  events:       { route: "/events",       title: "Events",       subtitle: "Recent activity",       icon: Bell },
  logs:         { route: "/logs",         title: "Logs",         subtitle: "Container output",      icon: ScrollText },
  catalog:      { route: "/catalog",      title: "Apps",         subtitle: "Install apps",          icon: AppWindow },
  helm:         { route: "/helm",         title: "Helm",         subtitle: "Releases & charts",     icon: Package },
  plugins:      { route: "/plugins",      title: "Plugins",      subtitle: "Cluster add-ons",       icon: Puzzle },
  apply:        { route: "/apply",        title: "Apply YAML",   subtitle: "Create from manifest",  icon: FilePlus2 },
  compose:      { route: "/compose",      title: "Migrate from Compose", subtitle: "Convert a docker-compose.yml to Kubernetes manifests", icon: FileInput },
  gitops:       { route: "/gitops",       title: "GitOps",       subtitle: "Deploy from Git",       icon: GitBranch },
  accounts:     { route: "/accounts",     title: "Accounts",     subtitle: "Registry credentials",  icon: UserRoundKey },
  settings:     { route: "/settings",     title: "Settings",     subtitle: "Preferences",           icon: Settings },
};

export interface NavGroup {
  title: string | null;
  panels: string[]; // panel keys
}

export const NAV_GROUPS: NavGroup[] = [
  { title: null, panels: ["overview", "assistant"] },
  { title: "Workloads", panels: ["deployments", "pods", "workloads", "rightsizing"] },
  { title: "Networking", panels: ["services", "ingresses"] },
  { title: "Config & Storage", panels: ["configmaps", "secrets", "storage", "databases", "backups"] },
  { title: "Cluster", panels: ["namespaces", "nodes", "connectivity", "rbac"] },
  { title: "Security & Certs", panels: ["certificates"] },
  { title: "Observability", panels: ["events", "logs"] },
  { title: "Self-host", panels: ["catalog", "helm", "plugins"] },
  { title: "Tools", panels: ["apply", "compose", "gitops"] },
  { title: "System", panels: ["accounts", "settings"] },
];
```

- [ ] **Step 2: Point `NavStrip.tsx` at the new module**

In `apps/web/src/shell/NavStrip.tsx`, delete the icon imports block (lines 11-44, the `lucide-react` import, the `RigelMark` import, and the `ComponentType, CSSProperties` type import) **only for symbols that were moved**, but keep `ChevronRight` / `ChevronDown` which the strip still uses. Concretely, replace the `lucide-react` import with just:

```ts
import { ChevronRight, ChevronDown } from "lucide-react";
```

Delete the `import { RigelMark } ...` line and the `import type { ComponentType, CSSProperties } from "react";` line. Then delete the `NavIcon` type, `PanelMeta` interface, `PANEL_META`, `NavGroup` interface, and `NAV_GROUPS` declarations (the current lines 54-126) and replace them with:

```ts
import { PANEL_META, NAV_GROUPS, type NavGroup } from "./navModel";
```

(`NavButton` reads `PANEL_META[panelKey]`; `NavGroup` is used implicitly via `NAV_GROUPS.map`. Keep the `NavCollapseState` import from `./navCollapse` unchanged.)

- [ ] **Step 3: Point `CommandPalette.tsx` at the new module**

In `apps/web/src/shell/CommandPalette.tsx` line 9, change:

```ts
import { PANEL_META, NAV_GROUPS } from "./NavStrip";
```

to:

```ts
import { PANEL_META, NAV_GROUPS } from "./navModel";
```

- [ ] **Step 4: Typecheck + run existing tests**

Run: `pnpm --filter web typecheck`
Expected: no errors.

Run: `pnpm --filter web test -- --run commandPaletteLogic navCollapse`
Expected: PASS (behavior unchanged — this is a pure move).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/shell/navModel.ts apps/web/src/shell/NavStrip.tsx apps/web/src/shell/CommandPalette.tsx
git commit -m "refactor(nav): extract PANEL_META/NAV_GROUPS into navModel"
```

---

## Task 2: Favorites persistence (`navFavorites.ts`)

**Files:**
- Create: `apps/web/src/shell/navFavorites.ts`
- Test: `apps/web/src/shell/navFavorites.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/shell/navFavorites.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import {
  NAV_FAVORITES_KEY,
  loadFavorites,
  saveFavorites,
  isFavorite,
  toggleFavorite,
} from "./navFavorites";

describe("navFavorites", () => {
  beforeEach(() => localStorage.clear());

  it("loads [] when nothing is stored", () => {
    expect(loadFavorites()).toEqual([]);
  });

  it("round-trips through localStorage", () => {
    saveFavorites(["deployments", "secrets"]);
    expect(localStorage.getItem(NAV_FAVORITES_KEY)).toBe('["deployments","secrets"]');
    expect(loadFavorites()).toEqual(["deployments", "secrets"]);
  });

  it("ignores malformed JSON and non-string entries", () => {
    localStorage.setItem(NAV_FAVORITES_KEY, "not json");
    expect(loadFavorites()).toEqual([]);
    localStorage.setItem(NAV_FAVORITES_KEY, '["ok", 3, null]');
    expect(loadFavorites()).toEqual(["ok"]);
  });

  it("toggleFavorite adds then removes without mutating input", () => {
    const a = ["deployments"];
    const b = toggleFavorite(a, "secrets");
    expect(b).toEqual(["deployments", "secrets"]);
    expect(a).toEqual(["deployments"]);
    expect(toggleFavorite(b, "deployments")).toEqual(["secrets"]);
  });

  it("isFavorite reflects membership", () => {
    expect(isFavorite(["pods"], "pods")).toBe(true);
    expect(isFavorite(["pods"], "nodes")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test -- --run navFavorites`
Expected: FAIL — cannot resolve `./navFavorites`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/shell/navFavorites.ts`:

```ts
/**
 * Favorited panel keys for the nav launcher, persisted as a JSON string array
 * in localStorage. Pure helpers (toggle/isFavorite) are separated from IO so
 * they can be unit-tested without a DOM.
 */
export const NAV_FAVORITES_KEY = "rigel.nav.favorites";

/** Load favorite panel keys; returns [] when absent or malformed. */
export function loadFavorites(): string[] {
  try {
    const raw = localStorage.getItem(NAV_FAVORITES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Persist favorite panel keys. */
export function saveFavorites(keys: string[]): void {
  try {
    localStorage.setItem(NAV_FAVORITES_KEY, JSON.stringify(keys));
  } catch {
    // ignore quota / private-browsing errors
  }
}

export function isFavorite(keys: string[], key: string): boolean {
  return keys.includes(key);
}

/** Add `key` if absent, remove it if present. Returns a new array. */
export function toggleFavorite(keys: string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web test -- --run navFavorites`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/shell/navFavorites.ts apps/web/src/shell/navFavorites.test.ts
git commit -m "feat(nav): favorites persistence for the launcher"
```

---

## Task 3: Launcher grid logic (`navLauncherLogic.ts`)

Pure functions that turn the nav model + favorites into the launcher's grouped grid, filter it by query, and compute arrow-key movement. No React, no imports from `navModel` (the model is passed in) so tests use tiny fixtures.

**Files:**
- Create: `apps/web/src/shell/navLauncherLogic.ts`
- Test: `apps/web/src/shell/navLauncherLogic.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/shell/navLauncherLogic.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildLauncherGroups,
  buildFavoritesCells,
  matchesQuery,
  flattenVisible,
  nextIndex,
  type LauncherGroup,
  type PanelInfo,
} from "./navLauncherLogic";

const META: Record<string, PanelInfo> = {
  overview: { title: "Overview", route: "/overview" },
  assistant: { title: "Assistant", route: "/assistant" },
  pods: { title: "Pods", route: "/pods" },
  deployments: { title: "Deployments", route: "/deployments" },
  secrets: { title: "Secrets", route: "/secrets" },
};

const GROUPS = [
  { title: null, panels: ["overview", "assistant"] },
  { title: "Workloads", panels: ["pods", "deployments", "ghost"] },
];

describe("buildLauncherGroups", () => {
  it("titles the null group 'General', alphabetizes cells, drops unknown keys", () => {
    const groups = buildLauncherGroups(GROUPS, META);
    expect(groups.map((g) => g.title)).toEqual(["General", "Workloads"]);
    expect(groups[0].cells.map((c) => c.title)).toEqual(["Assistant", "Overview"]);
    expect(groups[1].cells.map((c) => c.title)).toEqual(["Deployments", "Pods"]); // "ghost" dropped
    expect(groups[0].cells[0]).toEqual({ key: "assistant", title: "Assistant", route: "/assistant" });
  });
});

describe("buildFavoritesCells", () => {
  it("maps keys to cells alphabetically and drops unknown keys", () => {
    expect(buildFavoritesCells(["secrets", "deployments", "nope"], META).map((c) => c.title))
      .toEqual(["Deployments", "Secrets"]);
  });
});

describe("matchesQuery", () => {
  it("empty query matches everything; otherwise case-insensitive substring", () => {
    expect(matchesQuery("Deployments", "")).toBe(true);
    expect(matchesQuery("Deployments", "ploy")).toBe(true);
    expect(matchesQuery("Deployments", "POD")).toBe(false);
  });
});

describe("flattenVisible", () => {
  const groups: LauncherGroup[] = buildLauncherGroups(GROUPS, META);
  const favs = buildFavoritesCells(["secrets"], META);

  it("lists favorites first, then groups, in render order", () => {
    expect(flattenVisible(favs, groups, "").map((c) => c.key))
      .toEqual(["secrets", "assistant", "overview", "deployments", "pods"]);
  });

  it("filters by query across favorites and groups", () => {
    expect(flattenVisible(favs, groups, "o").map((c) => c.title))
      .toEqual(["Overview", "Deployments", "Pods"]);
  });
});

describe("nextIndex", () => {
  it("moves and wraps in a 3-column grid of 5", () => {
    expect(nextIndex(0, "ArrowRight", 3, 5)).toBe(1);
    expect(nextIndex(4, "ArrowRight", 3, 5)).toBe(0); // wrap end→start
    expect(nextIndex(0, "ArrowLeft", 3, 5)).toBe(4);  // wrap start→end
    expect(nextIndex(0, "ArrowDown", 3, 5)).toBe(3);
    expect(nextIndex(3, "ArrowDown", 3, 5)).toBe(1);  // (3+3)%5
    expect(nextIndex(1, "ArrowUp", 3, 5)).toBe(3);    // (1-3+5)%5
  });

  it("returns 0 for an empty grid", () => {
    expect(nextIndex(0, "ArrowRight", 3, 0)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test -- --run navLauncherLogic`
Expected: FAIL — cannot resolve `./navLauncherLogic`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/shell/navLauncherLogic.ts`:

```ts
/**
 * Pure helpers for the nav launcher grid. The nav model (PANEL_META / NAV_GROUPS)
 * is passed in so these functions stay free of React/icon imports and are unit-
 * testable with small fixtures. Selection uses render order (favorites first,
 * then groups) — NOT score order — so the grid stays visually coherent.
 */

export interface PanelInfo {
  title: string;
  route: string;
}

export interface LauncherCell {
  key: string;
  title: string;
  route: string;
}

export interface LauncherGroup {
  title: string;
  cells: LauncherCell[];
}

interface NavGroupInput {
  title: string | null;
  panels: string[];
}

type MetaLookup = Record<string, PanelInfo>;

function toCell(key: string, meta: MetaLookup): LauncherCell[] {
  const m = meta[key];
  return m ? [{ key, title: m.title, route: m.route }] : [];
}

const byTitle = (a: LauncherCell, b: LauncherCell) => a.title.localeCompare(b.title);

/** Group the nav model into launcher groups, alphabetized within each group. */
export function buildLauncherGroups(navGroups: NavGroupInput[], meta: MetaLookup): LauncherGroup[] {
  return navGroups.map((g) => ({
    title: g.title ?? "General",
    cells: g.panels.flatMap((k) => toCell(k, meta)).sort(byTitle),
  }));
}

/** Favorite keys → cells, alphabetized, unknown keys dropped. */
export function buildFavoritesCells(favorites: string[], meta: MetaLookup): LauncherCell[] {
  return favorites.flatMap((k) => toCell(k, meta)).sort(byTitle);
}

/** Empty query matches everything; otherwise case-insensitive substring on title. */
export function matchesQuery(title: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || title.toLowerCase().includes(q);
}

/** Flatten visible cells in render order (favorites, then each group) for indexing. */
export function flattenVisible(
  favoritesCells: LauncherCell[],
  groups: LauncherGroup[],
  query: string,
): LauncherCell[] {
  const out: LauncherCell[] = [];
  for (const c of favoritesCells) if (matchesQuery(c.title, query)) out.push(c);
  for (const g of groups) for (const c of g.cells) if (matchesQuery(c.title, query)) out.push(c);
  return out;
}

type ArrowKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

/** Move the selection index in a `cols`-wide grid of `count` cells, wrapping. */
export function nextIndex(current: number, key: ArrowKey, cols: number, count: number): number {
  if (count === 0) return 0;
  const delta =
    key === "ArrowRight" ? 1 :
    key === "ArrowLeft" ? -1 :
    key === "ArrowDown" ? cols :
    -cols;
  return (((current + delta) % count) + count) % count;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web test -- --run navLauncherLogic`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/shell/navLauncherLogic.ts apps/web/src/shell/navLauncherLogic.test.ts
git commit -m "feat(nav): pure grid logic for the launcher"
```

---

## Task 4: `NavLauncher` popover + `useNavLauncher()` hook

The floating popover anchored above the rail button: auto-focused search, Favorites section, category grids (3-col), per-cell favorite toggle, arrow-key + Enter navigation, Esc/click-outside dismiss. The `COLS` constant is `3` (matches the design). The `useNavLauncher()` hook mirrors `useCommandPalette()` but binds **⌘/ (Ctrl+/)**.

**Files:**
- Create: `apps/web/src/shell/NavLauncher.tsx`

- [ ] **Step 1: Create the component + hook**

Create `apps/web/src/shell/NavLauncher.tsx`:

```tsx
/**
 * Nav launcher — a floating grid popover anchored above the launcher button in
 * the cluster rail. Opens with ⌘/ (Ctrl+/) or the button. Search auto-focuses on
 * open; ↑/↓/←/→ move a selection across the grid, Enter opens it, Esc closes.
 * Lives alongside the ⌘K command palette (this is the browsable visual surface).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Search, Star } from "lucide-react";
import { PANEL_META, NAV_GROUPS } from "./navModel";
import {
  buildLauncherGroups,
  buildFavoritesCells,
  flattenVisible,
  nextIndex,
  type LauncherCell,
} from "./navLauncherLogic";
import { loadFavorites, saveFavorites, toggleFavorite } from "./navFavorites";

const COLS = 3;

interface NavLauncherProps {
  open: boolean;
  onClose: () => void;
}

export function NavLauncher({ open, onClose }: NavLauncherProps) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState<string[]>(() => loadFavorites());
  const [selected, setSelected] = useState(0);

  const favoritesCells = useMemo(() => buildFavoritesCells(favorites, PANEL_META), [favorites]);
  const groups = useMemo(() => buildLauncherGroups(NAV_GROUPS, PANEL_META), []);
  const visible = useMemo(
    () => flattenVisible(favoritesCells, groups, query),
    [favoritesCells, groups, query],
  );

  // Reset + autofocus each time the launcher opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Typing resets the selection to the first visible cell (the top match).
  useEffect(() => setSelected(0), [query]);

  const openCell = useCallback(
    (cell: LauncherCell) => {
      onClose();
      navigate(cell.route);
    },
    [navigate, onClose],
  );

  const toggleFav = useCallback((key: string) => {
    setFavorites((prev) => {
      const next = toggleFavorite(prev, key);
      saveFavorites(next);
      return next;
    });
  }, []);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      onClose();
      return;
    }
    if (e.key === "Enter") {
      const cell = visible[selected];
      if (cell) openCell(cell);
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => nextIndex(i, e.key as "ArrowLeft", COLS, visible.length));
    }
  }

  if (!open) return null;

  // Index of a cell within the flat `visible` list, for highlight + focus.
  const visIndex = (key: string) => visible.findIndex((c) => c.key === key);

  const renderCell = (cell: LauncherCell) => {
    const idx = visIndex(cell.key);
    const isSelected = idx === selected;
    const Icon = PANEL_META[cell.key]?.icon;
    const fav = favorites.includes(cell.key);
    return (
      <div
        key={cell.key + "@" + idx}
        role="option"
        aria-selected={isSelected}
        onClick={() => openCell(cell)}
        onMouseEnter={() => setSelected(idx)}
        className="group flex items-center justify-between gap-2.5 rounded-md px-2.5 py-2 cursor-pointer border transition-colors"
        style={{
          background: isSelected ? "var(--accent-primary-dim, rgba(56,189,248,0.15))" : "var(--surface-primary)",
          borderColor: isSelected ? "var(--accent-primary)" : "var(--border-subtle)",
        }}
      >
        <span className="flex items-center gap-2.5 min-w-0">
          <span
            className="flex items-center justify-center rounded-sm shrink-0"
            style={{ width: 26, height: 26, background: "var(--surface-sunken)" }}
          >
            {Icon && <Icon size={15} style={{ color: "var(--fg-secondary)" }} />}
          </span>
          <span
            className="text-xs truncate"
            style={{ color: "var(--fg-primary)", fontWeight: 500 }}
          >
            {cell.title}
          </span>
        </span>
        <button
          type="button"
          aria-label={fav ? `Unfavorite ${cell.title}` : `Favorite ${cell.title}`}
          onClick={(e) => { e.stopPropagation(); toggleFav(cell.key); }}
          className="shrink-0 p-0.5"
          style={{
            background: "transparent", border: "none", cursor: "pointer",
            opacity: fav ? 1 : 0,
          }}
        >
          <Star
            size={14}
            style={{
              color: fav ? "var(--accent-primary)" : "var(--fg-tertiary)",
              fill: fav ? "var(--accent-primary)" : "transparent",
            }}
            className={fav ? "" : "group-hover:!opacity-100"}
          />
        </button>
      </div>
    );
  };

  const gridStyle = { display: "grid", gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`, gap: 10 } as const;
  const sectionLabel = (label: string) => (
    <div
      className="text-3xs font-semibold uppercase"
      style={{ color: "var(--fg-tertiary)", letterSpacing: "0.06em", padding: "0 2px" }}
    >
      {label}
    </div>
  );

  return (
    // Transparent light-dismiss backdrop.
    <div
      style={{ position: "fixed", inset: 0, zIndex: 998 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Popover anchored above the launcher button (rail is 56px wide). */}
      <div
        role="dialog"
        aria-label="Navigation launcher"
        onKeyDown={handleKeyDown}
        style={{
          position: "fixed",
          left: 64,
          bottom: 52,
          width: 700,
          maxWidth: "calc(100vw - 80px)",
          maxHeight: "calc(100vh - 120px)",
          display: "flex",
          flexDirection: "column",
          background: "var(--surface-elevated)",
          border: "1px solid var(--border-strong)",
          borderRadius: 14,
          overflow: "hidden",
          boxShadow: "0 24px 52px rgba(0,0,0,0.65)",
        }}
      >
        {/* Search header */}
        <div
          className="flex items-center gap-2.5"
          style={{ padding: "14px 14px 12px", borderBottom: "1px solid var(--border-subtle)" }}
        >
          <span
            className="flex items-center gap-2.5 flex-1 rounded-md"
            style={{ padding: "10px 12px", background: "var(--surface-sunken)", border: "1px solid var(--border-subtle)" }}
          >
            <Search size={16} style={{ color: "var(--fg-tertiary)", flexShrink: 0 }} />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search resources…"
              className="text-xs flex-1"
              style={{ background: "transparent", border: "none", outline: "none", color: "var(--fg-primary)" }}
            />
            <span
              className="text-3xs"
              style={{ fontFamily: "monospace", color: "var(--fg-tertiary)", background: "#ffffff0f", padding: "2px 6px", borderRadius: 4 }}
            >
              Esc
            </span>
          </span>
        </div>

        {/* Scrollable body */}
        <div style={{ overflowY: "auto", padding: "14px 14px 20px", display: "flex", flexDirection: "column", gap: 18 }}>
          {favoritesCells.length > 0 && (
            <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span className="flex items-center gap-1.5">
                {sectionLabel("Favorites")}
                <Star size={11} style={{ color: "var(--accent-primary)", fill: "var(--accent-primary)" }} />
              </span>
              <div style={gridStyle}>
                {favoritesCells.filter((c) => visIndex(c.key) >= 0).map(renderCell)}
              </div>
            </section>
          )}

          {groups.map((g) => {
            const cells = g.cells.filter((c) => visIndex(c.key) >= 0);
            if (cells.length === 0) return null;
            return (
              <section key={g.title} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {sectionLabel(g.title)}
                <div style={gridStyle}>{cells.map(renderCell)}</div>
              </section>
            );
          })}

          {visible.length === 0 && (
            <div className="text-xs" style={{ textAlign: "center", padding: 20, color: "var(--fg-tertiary)", fontFamily: "monospace" }}>
              no matches
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Mount a single global keydown listener for ⌘/ (Ctrl+/). Returns
 * `[open, setOpen]` — mount ONCE at the app-shell level.
 */
export function useNavLauncher(): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === "/") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  return [open, setOpen];
}
```

> Note on selection when the same panel is both a favorite and in a group: `flattenVisible` lists it twice, so it occupies two positions in `visible`. `visIndex` returns the FIRST occurrence, so a favorited panel's group tile mirrors the favorite tile's highlight — acceptable (both open the same route). This is intentional and keeps the logic simple.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: no errors. (The component is not yet mounted; this only checks it compiles.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/shell/NavLauncher.tsx
git commit -m "feat(nav): NavLauncher popover + useNavLauncher hook"
```

---

## Task 5: Add the launcher button to `ClusterRail`

A circular button pinned to the bottom of the rail, visually distinct from the square cluster tiles. Idle = transparent + muted border + graphite icon; active = white fill + graphite icon.

**Files:**
- Modify: `apps/web/src/shell/ClusterRail.tsx:2` (icon import), `:28` (props), `:104-215` (nav layout)

- [ ] **Step 1: Import the grid icon**

In `apps/web/src/shell/ClusterRail.tsx` line 2, add `LayoutGrid` to the lucide import:

```ts
import { Lock, Plus, LayoutGrid } from "lucide-react";
```

- [ ] **Step 2: Accept launcher props**

Change the component signature (line 28) from:

```ts
export function ClusterRail() {
```

to:

```ts
export function ClusterRail({
  launcherOpen = false,
  onToggleLauncher,
}: {
  launcherOpen?: boolean;
  onToggleLauncher?: () => void;
} = {}) {
```

- [ ] **Step 3: Restructure the rail to pin the button at the bottom**

The `<nav>` (line 105) is already `flexDirection: "column"`. The existing `<div style={{ flex: 1, ... }}>` (line 114) holds the scrolling tiles. Add the launcher button as a **sibling after** that `flex:1` div (so it sits at the bottom), before the modals. Insert this block immediately after the closing `</div>` of the `flex:1` container (the `</div>` on line 215) and before `<ClusterIconPicker ...>`:

```tsx
      {/* Nav launcher trigger — circular, distinct from the square cluster
          tiles. Idle: muted border + graphite icon. Active: white fill. */}
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
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/shell/ClusterRail.tsx
git commit -m "feat(nav): launcher button pinned to the cluster rail"
```

---

## Task 6: Wire into `App.tsx` and remove the sidebar collapse

Mount `<NavLauncher>`, own its open state, pass it to `ClusterRail`, drop `<NavStrip>`, and remove the now-dead whole-sidebar collapse state (and its `GlobalHeader` toggle in Task 6b).

**Files:**
- Modify: `apps/web/src/App.tsx` (imports, `AppContent`, body row)

- [ ] **Step 1: Swap imports**

In `apps/web/src/App.tsx`:
- Delete line 41: `import NavStrip from "@/shell/NavStrip";`
- After the `CommandPalette` import (line 45), add:

```ts
import { NavLauncher, useNavLauncher } from "@/shell/NavLauncher";
```

- Remove the `loadSidebarCollapsed, saveSidebarCollapsed` import. Find the import line that pulls them from `@/shell/navCollapse` and delete the whole line (they are the only symbols used from that module in App).

- [ ] **Step 2: Replace sidebar-collapse state with launcher state**

In `AppContent`, replace the `sidebarCollapsed` block (current lines 105-114):

```ts
  // Whole-sidebar collapse (icon-only rail). Owned here, persisted on change,
  // driven by the GlobalHeader toggle. Distinct from the per-group nav collapse.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(loadSidebarCollapsed);
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((v) => {
      const next = !v;
      saveSidebarCollapsed(next);
      return next;
    });
  }, []);
```

with:

```ts
  // Nav launcher (⌘/) — the grid popover that replaced the nav strip.
  const [launcherOpen, setLauncherOpen] = useNavLauncher();
```

- [ ] **Step 3: Mount the launcher next to the command palette**

After line 248 (`<CommandPalette open={paletteOpen} ... />`), add:

```tsx
      <NavLauncher open={launcherOpen} onClose={() => setLauncherOpen(false)} />
```

- [ ] **Step 4: Update `GlobalHeader` usage**

Change the `<GlobalHeader ... />` block (lines 257-262) — remove the two sidebar props:

```tsx
      <GlobalHeader
        onOpenSearch={() => setPaletteOpen(true)}
        onOpenAccount={() => setAccountOpen(true)}
      />
```

- [ ] **Step 5: Replace `<NavStrip>` with launcher wiring on the rail**

In the body row, delete the `<NavStrip collapsed={sidebarCollapsed} />` line (272) and its comment (271), and change `<ClusterRail />` (line 269) to:

```tsx
        <ClusterRail launcherOpen={launcherOpen} onToggleLauncher={() => setLauncherOpen(!launcherOpen)} />
```

- [ ] **Step 6: Typecheck (expect a GlobalHeader error until 6b)**

Run: `pnpm --filter web typecheck`
Expected: an error in `GlobalHeader.tsx` about required props `sidebarCollapsed`/`onToggleSidebar` — fixed in the next sub-task. (If `useCallback` is now unused elsewhere, leave it; it is still used by other handlers in this file.)

---

## Task 6b: Remove the sidebar toggle from `GlobalHeader`

**Files:**
- Modify: `apps/web/src/shell/GlobalHeader.tsx:10,16-34,63-88`

- [ ] **Step 1: Drop the props from the interface**

In `apps/web/src/shell/GlobalHeader.tsx`, remove `sidebarCollapsed` and `onToggleSidebar` from `GlobalHeaderProps` (lines 17-18) and from the destructured params (lines 31-32). The interface keeps `onOpenSearch` and `onOpenAccount`.

- [ ] **Step 2: Delete the toggle button**

Remove the entire "Sidebar collapse toggle" `<button>` block (lines 63-88, the comment through the closing `</button>`).

- [ ] **Step 3: Drop the now-unused icon import**

On line 10, remove `PanelLeftClose, PanelLeftOpen` from the `lucide-react` import, keeping the rest:

```ts
import { Search, User } from "lucide-react";
```

- [ ] **Step 4: Typecheck + build**

Run: `pnpm --filter web typecheck`
Expected: no errors.

Run: `pnpm --filter web build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/shell/GlobalHeader.tsx
git commit -m "feat(nav): mount launcher, remove nav strip + sidebar collapse"
```

---

## Task 7: Delete dead code

`NavStrip` and both collapse mechanisms are now unreferenced.

**Files:**
- Delete: `apps/web/src/shell/NavStrip.tsx`, `apps/web/src/shell/navCollapse.ts`, `apps/web/src/shell/navCollapse.test.ts`

- [ ] **Step 1: Verify nothing imports them**

Run: `grep -rn "NavStrip\|navCollapse" apps/web/src`
Expected: no matches (Task 1 moved the model out; Task 6 removed the last App import).

- [ ] **Step 2: Delete the files**

```bash
git rm apps/web/src/shell/NavStrip.tsx apps/web/src/shell/navCollapse.ts apps/web/src/shell/navCollapse.test.ts
```

- [ ] **Step 3: Typecheck + full test + build**

Run: `pnpm --filter web typecheck`
Expected: no errors.

Run: `pnpm --filter web test -- --run`
Expected: all suites PASS (navCollapse suite is gone; navFavorites + navLauncherLogic pass).

Run: `pnpm --filter web build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(nav): delete NavStrip and dead collapse code"
```

---

## Task 8: Live verification in the desktop app

Behavior the automated checks can't confirm (positioning, focus, keys). No web dev server — use the desktop shell.

- [ ] **Step 1: Launch the app**

Run (from repo root): `pnpm --filter desktop dev`

- [ ] **Step 2: Verify the launcher**

Confirm each:
- The 200px nav strip is gone; content fills the reclaimed width.
- A circular four-grid button sits at the bottom of the cluster rail. Idle = muted border + graphite icon.
- Pressing **⌘/** (Ctrl+/) opens the popover above the button; the button fills white; the search input is focused immediately.
- Typing filters the grid; **Enter** opens the top match; **Esc** and click-outside close it.
- **← → ↑ ↓** move the highlighted cell across the grid; Enter opens the highlight.
- Hovering a cell reveals a star; clicking it (without navigating) adds the panel to a **Favorites** section pinned at the top; reload persists it.
- **⌘K** still opens the old command palette (unaffected).

- [ ] **Step 3: Mark the PR ready**

```bash
gh pr ready
```

---

## Self-Review Notes

- **Spec coverage:** launcher button + two states (Task 5); floating popover with shadow/rounded/light-dismiss (Task 4); search auto-focus on open (Task 4, Step 1 `useEffect`); Favorites pinned + persisted (Tasks 2, 4); category grids 3-col alphabetized in `NAV_GROUPS` order with the `null` group as "General" (Task 3); arrow-key 2D nav + Enter/Esc (Tasks 3, 4); ⌘/ shortcut (Task 4 hook); lives alongside ⌘K (untouched; Task 1 only re-points its import); nav strip removed + width reclaimed (Task 6); model preserved via `navModel` (Task 1). Tailwind utilities + tokens, no hand CSS beyond inline token styles matching the existing shell's inline-style convention.
- **Type consistency:** `LauncherCell` / `LauncherGroup` / `PanelInfo` defined in Task 3 and consumed unchanged in Task 4. `PANEL_META` (Record<string, PanelMeta>) is structurally assignable to the `MetaLookup` (Record<string, PanelInfo>) params since `PanelMeta` has `title` + `route`. Hook signature `[boolean, (v: boolean) => void]` matches `useCommandPalette`. `nextIndex` cast `e.key as "ArrowLeft"` is safe — it is only reached inside the arrow-key branch.
- **No placeholders:** every code step is complete and runnable.
