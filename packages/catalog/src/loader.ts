// Catalog loader — reads the bundled catalog.json (55 apps) and returns the
// typed array. The JSON is the SAME file the Swift app ships
// (Sources/Helmsman/Resources/catalog.json), copied into this package so both
// apps load an identical catalog.

import catalogJson from "../catalog.json" with { type: "json" };
import type { CatalogApp } from "./types";

/**
 * The full catalog, statically imported. Synchronous — the catalog ships with
 * the app, there is no remote fetch. The cast is safe because catalog.json is
 * the shared, schema-validated contract.
 */
export const CATALOG: CatalogApp[] = catalogJson as unknown as CatalogApp[];

/**
 * Load the catalog. Async to mirror the documented `loadCatalog(): Promise<…>`
 * signature and to leave room for a future remote fetch, but resolves
 * immediately from the bundled JSON.
 */
export async function loadCatalog(): Promise<CatalogApp[]> {
  return CATALOG;
}
