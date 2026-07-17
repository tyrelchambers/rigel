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

export function buildLauncherGroups(navGroups: NavGroupInput[], meta: MetaLookup): LauncherGroup[] {
  return navGroups.map((g) => ({
    title: g.title ?? "General",
    cells: g.panels.flatMap((k) => toCell(k, meta)).sort(byTitle),
  }));
}

export function buildFavoritesCells(favorites: string[], meta: MetaLookup): LauncherCell[] {
  return favorites.flatMap((k) => toCell(k, meta)).sort(byTitle);
}

export function matchesQuery(title: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || title.toLowerCase().includes(q);
}

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

export type ArrowKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

export function moveSelection(current: number, key: ArrowKey, sections: number[], cols: number): number {
  const total = sections.reduce((n, s) => n + s, 0);
  if (total === 0) return 0;
  if (key === "ArrowLeft") return (current - 1 + total) % total;
  if (key === "ArrowRight") return (current + 1) % total;

  const bases: number[] = [];
  let acc = 0;
  for (const s of sections) {
    bases.push(acc);
    acc += s;
  }

  let si = sections.length - 1;
  for (let i = 0; i < sections.length; i++) {
    if (current < bases[i] + sections[i]) {
      si = i;
      break;
    }
  }

  const base = bases[si];
  const len = sections[si];
  const p = current - base;
  const col = p % cols;
  const row = Math.floor(p / cols);
  const rows = Math.ceil(len / cols);

  if (key === "ArrowDown") {
    if (row + 1 < rows) return base + Math.min((row + 1) * cols + col, len - 1);
    const ns = (si + 1) % sections.length;
    return bases[ns] + Math.min(col, sections[ns] - 1);
  }

  if (row > 0) return base + (row - 1) * cols + col;
  const ps = (si - 1 + sections.length) % sections.length;
  const plen = sections[ps];
  const lastRowStart = (Math.ceil(plen / cols) - 1) * cols;
  return bases[ps] + Math.min(lastRowStart + col, plen - 1);
}
