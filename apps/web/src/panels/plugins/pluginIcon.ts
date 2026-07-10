import { Activity, Scale, BadgeCheck, Signpost, Puzzle, type LucideIcon } from "lucide-react";
import type { ClusterAddon } from "@rigel/catalog";

const ICONS: Record<string, LucideIcon> = { Activity, Scale, BadgeCheck, Signpost };

/** Resolve an add-on's lucide icon by name, falling back to a generic Puzzle. */
export function pluginIcon(addon: ClusterAddon): LucideIcon {
  return ICONS[addon.icon] ?? Puzzle;
}
