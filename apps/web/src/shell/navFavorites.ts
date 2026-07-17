export const NAV_FAVORITES_KEY = "rigel.nav.favorites";

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

export function saveFavorites(keys: string[]): void {
  try {
    localStorage.setItem(NAV_FAVORITES_KEY, JSON.stringify(keys));
  } catch {
    return;
  }
}

export function isFavorite(keys: string[], key: string): boolean {
  return keys.includes(key);
}

export function toggleFavorite(keys: string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key];
}
