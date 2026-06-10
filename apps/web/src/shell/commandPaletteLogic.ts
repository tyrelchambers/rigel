/**
 * Pure helpers for the ⌘K command palette.
 * All functions are side-effect free and unit-tested (commandPalette.test.ts).
 */

export interface PaletteEntry {
  id: string;
  title: string;
  subtitle: string;
  route: string;
  group: string;
}

/**
 * Score a single entry against a query using the same scoring logic as the
 * native Swift CommandPalette `filterAndRank`:
 *  - 1000: exact match on title
 *  - 500 : title starts with query
 *  - 200 - offset: title contains query (offset is position of first match)
 *  - 80  - offset: subtitle contains query
 *  - -1  : no match
 */
export function scoreEntry(entry: PaletteEntry, query: string): number {
  const q = query.trim().toLowerCase();
  if (q === "") return 0;

  const title = entry.title.toLowerCase();
  const sub = entry.subtitle.toLowerCase();

  if (title === q) return 1000;
  if (title.startsWith(q)) return 500;
  const titleIdx = title.indexOf(q);
  if (titleIdx >= 0) return 200 - titleIdx;
  const subIdx = sub.indexOf(q);
  if (subIdx >= 0) return 80 - subIdx;
  return -1;
}

/**
 * Filter and rank the entries by query. Empty query returns all entries
 * (up to `limit`). Non-empty query filters to matching entries sorted by
 * score descending. Ties preserve original order (stable sort).
 */
export function filterEntries(
  entries: PaletteEntry[],
  query: string,
  limit = 80,
): PaletteEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") return entries.slice(0, limit);

  const scored: Array<{ entry: PaletteEntry; score: number; idx: number }> = [];
  for (let i = 0; i < entries.length; i++) {
    const score = scoreEntry(entries[i], query);
    if (score >= 0) scored.push({ entry: entries[i], score, idx: i });
  }
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return scored.slice(0, limit).map((s) => s.entry);
}

/**
 * Clamp `index` to [0, count-1]. Returns 0 when count is 0. Implements
 * wrap-around: index < 0 → count - 1; index >= count → 0.
 */
export function wrapIndex(index: number, count: number): number {
  if (count === 0) return 0;
  if (index < 0) return count - 1;
  if (index >= count) return 0;
  return index;
}
