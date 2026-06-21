import type { ProviderKind } from "./clusterTile";
import { providerDefaultIcon, CLUSTER_ICONS, type IconId } from "./clusterIcons";

const STORAGE_KEY = "rigel.cluster.icons";

/** Per-context icon overrides: contextName → IconId. Absent/corrupt → {}. */
export function loadIconOverrides(): Record<string, IconId> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string>;
    const out: Record<string, IconId> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && v in CLUSTER_ICONS) out[k] = v as IconId;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveIconOverrides(map: Record<string, IconId>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* non-browser / storage disabled */
  }
}

/** The icon to show: the user's override for this context, else the provider default. */
export function resolveIconId(
  contextName: string,
  provider: ProviderKind,
  overrides: Record<string, IconId>,
): IconId {
  return overrides[contextName] ?? providerDefaultIcon(provider);
}
