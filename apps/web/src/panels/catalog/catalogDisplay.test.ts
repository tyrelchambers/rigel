import { describe, expect, test } from "vitest";
import type { CatalogApp } from "@helmsman/catalog";
import {
  matchesSearch,
  filterCatalog,
  availableCategories,
  requirementsSummary,
} from "./catalogDisplay";

function app(partial: Partial<CatalogApp> & { id: string }): CatalogApp {
  return {
    name: partial.name ?? partial.id,
    tagline: partial.tagline ?? "",
    description: partial.description ?? "",
    category: partial.category ?? "other",
    iconSystemName: "x",
    docsURL: "https://x",
    tags: partial.tags ?? [],
    matchImages: [],
    requirements: partial.requirements ?? { cpuRequest: "100m", memoryRequest: "128Mi" },
    persistence: false,
    exposesIngress: false,
    installPromptTemplate: "",
    ...partial,
  } as CatalogApp;
}

describe("matchesSearch", () => {
  const a = app({
    id: "vaultwarden",
    name: "Vaultwarden",
    tagline: "Password manager",
    description: "A Bitwarden-compatible server",
    tags: ["secrets", "security"],
  });

  test("empty query matches", () => {
    expect(matchesSearch(a, "")).toBe(true);
  });
  test("matches name case-insensitively", () => {
    expect(matchesSearch(a, "VAULT")).toBe(true);
  });
  test("matches tagline", () => {
    expect(matchesSearch(a, "password")).toBe(true);
  });
  test("matches description", () => {
    expect(matchesSearch(a, "bitwarden")).toBe(true);
  });
  test("matches a tag", () => {
    expect(matchesSearch(a, "security")).toBe(true);
  });
  test("no match", () => {
    expect(matchesSearch(a, "nextcloud")).toBe(false);
  });
});

describe("filterCatalog", () => {
  const catalog = [
    app({ id: "vaultwarden", name: "Vaultwarden", category: "productivity" }),
    app({ id: "postgres", name: "Postgres", category: "database" }),
    app({ id: "grafana", name: "Grafana", category: "observability" }),
  ];

  test("scope=installed keeps only installed ids", () => {
    const out = filterCatalog(catalog, {
      scope: "installed",
      installedIDs: new Set(["postgres"]),
      category: null,
      search: "",
    });
    expect(out.map((a) => a.id)).toEqual(["postgres"]);
  });

  test("category filter", () => {
    const out = filterCatalog(catalog, {
      scope: "all",
      installedIDs: new Set(),
      category: "database",
      search: "",
    });
    expect(out.map((a) => a.id)).toEqual(["postgres"]);
  });

  test("search filter", () => {
    const out = filterCatalog(catalog, {
      scope: "all",
      installedIDs: new Set(),
      category: null,
      search: "graf",
    });
    expect(out.map((a) => a.id)).toEqual(["grafana"]);
  });

  test("combined scope + category + search", () => {
    const out = filterCatalog(catalog, {
      scope: "installed",
      installedIDs: new Set(["postgres", "grafana"]),
      category: "observability",
      search: "graf",
    });
    expect(out.map((a) => a.id)).toEqual(["grafana"]);
  });

  test("sorts results alphabetically by name (case-insensitive), ignoring catalog order", () => {
    const unordered = [
      app({ id: "zammad", name: "Zammad" }),
      app({ id: "affine", name: "AFFiNE" }),
      app({ id: "ntfy", name: "ntfy" }),
      app({ id: "memos", name: "Memos" }),
    ];
    const out = filterCatalog(unordered, {
      scope: "all",
      installedIDs: new Set(),
      category: null,
      search: "",
    });
    expect(out.map((a) => a.name)).toEqual(["AFFiNE", "Memos", "ntfy", "Zammad"]);
  });
});

describe("availableCategories", () => {
  test("preserves canonical order and drops absent", () => {
    const catalog = [
      app({ id: "a", category: "network" }),
      app({ id: "b", category: "database" }),
    ];
    expect(availableCategories(catalog, ["database", "observability", "network"])).toEqual([
      "database",
      "network",
    ]);
  });
});

describe("requirementsSummary", () => {
  test("includes storage when present", () => {
    const a = app({
      id: "x",
      requirements: { cpuRequest: "250m", memoryRequest: "512Mi", storageGiB: 10 },
    });
    expect(requirementsSummary(a)).toBe("cpu 250m · mem 512Mi · 10Gi");
  });
  test("omits storage when absent", () => {
    const a = app({ id: "x", requirements: { cpuRequest: "100m", memoryRequest: "128Mi" } });
    expect(requirementsSummary(a)).toBe("cpu 100m · mem 128Mi");
  });
});
