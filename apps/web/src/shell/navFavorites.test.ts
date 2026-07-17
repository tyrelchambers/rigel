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
