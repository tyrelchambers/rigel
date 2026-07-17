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
