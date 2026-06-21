/**
 * Two-letter initials for a cluster tile. Splits the context name on non-
 * alphanumeric separators and takes the first letter of the first two parts; a
 * single part uses its first two letters. Falls back to "?" when there's nothing.
 */
export function tileInitials(name: string): string {
  const parts = name.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const letters = parts.length === 1 ? parts[0]!.slice(0, 2) : parts[0]![0]! + parts[1]![0]!;
  return letters.toUpperCase() || "?";
}
