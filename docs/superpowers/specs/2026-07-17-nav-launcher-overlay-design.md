# Nav Launcher Overlay — Design

## Summary

Replace the persistent 200px vertical navigation strip (`NavStrip`) with an on-demand
**grid launcher**: a floating popover that opens from a circular button pinned to the
bottom of the cluster rail, or via the keyboard shortcut **⌘/** (Ctrl+/ on Windows/Linux).
The popover shows every panel as an icon+label cell, grouped by category and alphabetized
within each group, with a search field and a user-managed **Favorites** section at the top.

Removing the always-on strip reclaims ~200px of horizontal space for panel content. The
launcher, the favorites section, and the existing ⌘K command palette together become the
navigation surface.

## Goals

- Reclaim the horizontal space taken by the persistent nav strip.
- Provide a fast, browsable, visual way to reach any panel.
- Let users pin frequently used panels (e.g. Deployments, Secrets) so they sit at the top.
- Keep the existing ⌘K fuzzy-search palette; the launcher is a complementary surface.

## Non-goals

- Not replacing or changing the ⌘K command palette (`CommandPalette.tsx`). It stays as-is.
- Not changing routing, panel components, or the `PANEL_META` / `NAV_GROUPS` data model.
- No cloud/entitlement gating; this is pure client UI.

## Current state (what exists today)

- `apps/web/src/shell/ClusterRail.tsx` — 60px Discord-style vertical rail of cluster-context
  icons, leftmost in the shell. Tiles flow in a `flex:1` column; a `+` add-cluster button
  follows them. This rail **stays**.
- `apps/web/src/shell/NavStrip.tsx` — the 200px (52px collapsed) vertical nav strip. Holds
  the single source of truth for nav items:
  - `PANEL_META: Record<string, { route, title, subtitle, icon }>`
  - `NAV_GROUPS: NavGroup[]` where `NavGroup = { title: string | null, panels: string[] }`
  These two exports are reused by the command palette and will be reused by the launcher.
  The **rendered strip** is removed; the **data exports stay** (moved if needed, see below).
- `apps/web/src/shell/CommandPalette.tsx` — hand-rolled full-screen ⌘K overlay + the
  `useCommandPalette()` keydown hook pattern. The launcher copies this hook pattern.
- `App.tsx` — assembles the shell (`<ClusterRail/>`, `<NavStrip/>`, `<Routes/>`), mounts
  `<CommandPalette/>`, and owns the ⌘J / Ctrl+` keydown effects.
- Routing is React Router v7 (`NavLink` / `useNavigate()`); panels are `<Route>`s in App.tsx.

## Design

### Shell change

Remove `<NavStrip>` from `App.tsx`. The body row becomes: **cluster rail → main content**
(and the existing chat rail on the right, unchanged). The main content area expands to fill
the reclaimed width.

`PANEL_META` and `NAV_GROUPS` are the nav model and must survive the strip's removal. Move
them into a small dedicated module (e.g. `apps/web/src/shell/navModel.ts`) and re-export from
their old location if any importer still needs the old path. The launcher and the command
palette both import from this module.

### Launcher button (in the cluster rail)

A circular button pinned to the **bottom** of `ClusterRail`'s `<nav>` (a sibling after the
`flex:1` tile column, so it sits at the bottom of the column). Visually distinct from the
square cluster tiles: it is a **circle** (~38px).

- **Idle:** transparent fill, muted border (`--border-strong`), four-grid icon
  (`grid-2x2`) in `--foreground-tertiary` (graphite).
- **Active / open:** fills solid **white**, four-grid icon turns **graphite** (~`#18181B`).

Clicking toggles the popover. `aria-label="Open navigation"`, `aria-expanded` reflects state.

### The popover

A floating popover anchored above the launcher button (opens upward/right from the
bottom-left), with rounded corners (~14px), elevated surface (`--surface-elevated`),
`--border-strong` hairline, and an outer drop shadow so it reads as floating. It is a
popover (light-dismiss: click-outside / Esc), **not** a full-screen modal. A subtle scrim
sits behind it so it reads as elevated while the app stays visible.

Fixed size (roughly 700 wide). The body is **vertically scrollable**; a scrollbar and a
bottom fade indicate overflow.

Structure, top to bottom:

1. **Header / search.** A search input (`Search resources…`) with a search icon and an
   `Esc` hint chip. Typing filters the grid live (reuse `filterEntries()` / `scoreEntry()`
   from `commandPaletteLogic.ts` where practical). Enter opens the top match. Search matches
   on panel title.

2. **Favorites** section (only when the user has favorites). Header label "FAVORITES" with a
   filled star. Favorited panels render as cells with an accent tint and a filled accent
   star, alphabetized. Persisted client-side (see Favorites below).

3. **Category groups**, in `NAV_GROUPS` order, each: a small uppercase caption header, then a
   **3-column grid** of cells, **alphabetized within the group**. The `null`-title group
   (Overview, Assistant) renders under a "General" caption. Groups: General, Workloads,
   Networking, Config & Storage, Cluster, Security & Certs, Observability, Self-Host, Tools,
   System.

Grids are built as explicit rows of 3 (no CSS-less wrapping assumptions in the design; in
code use a real CSS grid, `grid-template-columns: repeat(3, 1fr)`).

### The cell

Reusable `LaunchCell`: a rounded, bordered, horizontally-laid item —
`[ icon tile ] Label ............ [ star ]`.

- Icon tile: small rounded square, the panel's `PANEL_META.icon`.
- Label: the panel title.
- Star (favorite toggle): faint/hidden by default, appears on hover; filled + accent when
  favorited. Clicking the star toggles favorite without navigating. Clicking the rest of the
  cell navigates (`useNavigate(meta.route)`) and closes the popover.

### Favorites

- A list of panel keys, persisted in `localStorage` (follow the existing `navCollapse.ts`
  persistence pattern: `load` / `save` helpers in a small module, e.g. `navFavorites.ts`).
- Toggled via the per-cell star. Order within Favorites is alphabetical by title.
- Empty favorites → the Favorites section is not rendered.

### Keyboard

- **⌘/ (Ctrl+/):** toggle the launcher. Implement with a `useNavLauncher()` hook mirroring
  `useCommandPalette()` (a `window` keydown listener returning `[open, setOpen]`), mounted
  once in `App.tsx`. **On open, auto-focus the search input** (autofocus on mount / when
  `open` flips true) so the user can type to filter immediately — whether opened by ⌘/ or by
  clicking the launcher button.
- **Esc:** close. **↑/↓/←/→ + Enter:** move selection across the grid and open (reuse the
  palette's index/`wrapIndex` approach adapted to a 2D grid, or start with type-to-search +
  Enter and add arrow nav as a follow-up).
- ⌘K (command palette), ⌘J (chat), Ctrl+` (terminal) are unchanged and must not collide.

## Components / files

New:
- `apps/web/src/shell/NavLauncher.tsx` — the popover overlay + `useNavLauncher()` hook.
- `apps/web/src/shell/LaunchCell.tsx` — the reusable cell (or co-located in NavLauncher).
- `apps/web/src/shell/navFavorites.ts` — favorites persistence (`load`/`save`/`toggle`/`isFav`).
- `apps/web/src/shell/navModel.ts` — home for `PANEL_META` / `NAV_GROUPS` (moved from NavStrip).

Changed:
- `apps/web/src/shell/ClusterRail.tsx` — add the bottom launcher button + open callback.
- `apps/web/src/shell/App.tsx` — drop `<NavStrip>`, mount `<NavLauncher>`, wire ⌘/ + button.

Removed:
- `apps/web/src/shell/NavStrip.tsx` rendered component (delete after `navModel` extraction).
  `navCollapse.ts`'s sidebar-collapse helpers become dead once the strip is gone; remove the
  now-unused pieces.

## Testing

- Unit: favorites persistence (`navFavorites.ts`) — toggle/isFav/load/save round-trip.
- Unit: grid grouping/sorting helper — categories in `NAV_GROUPS` order, alphabetical within,
  favorites hoisted and de-duplicated.
- Unit: search filtering reuses `commandPaletteLogic` and stays covered by its tests.
- Verify via `pnpm --filter web typecheck` + `vitest`; live check via `pnpm --filter desktop dev`
  (no web dev server).

## Design reference

Pencil frame **"Nav Launcher — overlay"** in `clankerlocal.pen` (midnight palette) —
shows the rail + launcher button (both states) + the open popover with search, Favorites,
and the category grids. Implement in Tailwind utilities + design tokens (no hand CSS).

## Open questions

- Arrow-key 2D grid navigation: ship in v1 or fast-follow? (Default: type-to-search + Enter
  in v1, arrow nav as follow-up.)
