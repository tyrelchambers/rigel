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
