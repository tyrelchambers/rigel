// Catalog grid filtering — search, category, scope. Pure helpers so the panel
// stays declarative and the matching rules are unit-testable
// (docs/parity/catalog.md §"State & Filtering").
import type { AppCategory, CatalogApp } from "@rigel/catalog";

export type Scope = "all" | "installed";

/** Case-insensitive substring match on name, tagline, description, tags. */
export function matchesSearch(app: CatalogApp, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return (
    app.name.toLowerCase().includes(q) ||
    app.tagline.toLowerCase().includes(q) ||
    app.description.toLowerCase().includes(q) ||
    app.tags.some((t) => t.toLowerCase().includes(q))
  );
}

/**
 * Apply scope + category + search to the catalog, sorted alphabetically by name
 * (case-insensitive) — matches the Swift app's `filtered` ordering so the grid
 * is stable regardless of the catalog.json insertion order.
 */
export function filterCatalog(
  catalog: CatalogApp[],
  opts: {
    scope: Scope;
    installedIDs: Set<string>;
    category: AppCategory | null;
    search: string;
  },
): CatalogApp[] {
  return catalog
    .filter((app) => {
      if (opts.scope === "installed" && !opts.installedIDs.has(app.id)) return false;
      if (opts.category && app.category !== opts.category) return false;
      return matchesSearch(app, opts.search);
    })
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

/** Categories present in the catalog, in the canonical pill order. */
export function availableCategories(
  catalog: CatalogApp[],
  order: AppCategory[],
): AppCategory[] {
  const present = new Set(catalog.map((a) => a.category));
  return order.filter((c) => present.has(c));
}

/** Format the requirements line for a card: "cpu · mem · storage". */
export function requirementsSummary(app: CatalogApp): string {
  const parts: string[] = [];
  parts.push(`cpu ${app.requirements.cpuRequest}`);
  parts.push(`mem ${app.requirements.memoryRequest}`);
  if (app.requirements.storageGiB != null) {
    parts.push(`${app.requirements.storageGiB}Gi`);
  }
  return parts.join(" · ");
}
