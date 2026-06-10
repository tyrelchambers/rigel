/**
 * Stable per-app accent color derived from the app id.
 * Returns an HSL hue (0–359) that's consistent across renders.
 * We bias toward the visually richer bands (skip muddy yellows 50–70).
 */
export function appHue(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  // Distribute across 12 visually distinct hue bands, skipping muddy 50–70
  const bands = [0, 15, 90, 120, 150, 180, 200, 220, 250, 280, 310, 340];
  return bands[hash % bands.length]!;
}

/**
 * Returns the two gradient stop colors for an app icon tile.
 * A subtle gradient gives the tile depth without being garish.
 */
export function appIconGradient(id: string): { from: string; to: string } {
  const h = appHue(id);
  return {
    from: `hsl(${h} 65% 42%)`,
    to: `hsl(${(h + 25) % 360} 55% 28%)`,
  };
}

/**
 * A faint tinted border/glow color for hover state.
 */
export function appAccentAlpha(id: string, alpha = 0.45): string {
  const h = appHue(id);
  return `hsl(${h} 55% 50% / ${alpha})`;
}
