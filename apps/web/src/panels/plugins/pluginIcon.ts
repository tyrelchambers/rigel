import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faWaveform,
  faScaleBalanced,
  faCircleCheck,
  faSignsPost,
  faPuzzlePiece,
} from "@awesome.me/kit-6050953220/icons/classic/solid";
import type { ClusterAddon } from "@rigel/catalog";

const ICONS: Record<string, IconDefinition> = {
  Activity: faWaveform,
  Scale: faScaleBalanced,
  BadgeCheck: faCircleCheck,
  Signpost: faSignsPost,
};

/** Resolve an add-on's icon by name, falling back to a generic puzzle piece. */
export function pluginIcon(addon: ClusterAddon): IconDefinition {
  return ICONS[addon.icon] ?? faPuzzlePiece;
}
