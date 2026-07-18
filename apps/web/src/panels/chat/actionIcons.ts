// Map action kinds → Font Awesome icons. Mirrors the Swift SF Symbol mapping in
// SuggestedAction.systemImage (restart→arrow.clockwise, scale→arrow.up.arrow.down,
// …). See docs/parity/contracts.md § 1 for the full kind list.
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faArrowRotateRight,
  faArrowsUpDown,
  faArrowRotateLeft,
  faSliders,
  faBox,
  faGauge,
  faCirclePause,
  faCirclePlay,
  faTrashCan,
  faBan,
  faCircleCheck,
  faCube,
  faBolt,
  faFolderPlus,
  faLink,
  faLinkSlash,
  faTerminal,
  faBoxOpen,
  faWrench,
} from "@awesome.me/kit-6050953220/icons/classic/solid";

const ICONS: Record<string, IconDefinition> = {
  restart: faArrowRotateRight,
  scale: faArrowsUpDown,
  rollback: faArrowRotateLeft,
  setEnv: faSliders,
  setImage: faBox,
  setResources: faGauge,
  pause: faCirclePause,
  resume: faCirclePlay,
  deletePod: faTrashCan,
  deleteWorkload: faTrashCan,
  cordon: faBan,
  uncordon: faCircleCheck,
  drain: faCube,
  suspendCronJob: faCirclePause,
  resumeCronJob: faCirclePlay,
  triggerCronJob: faBolt,
  createNamespace: faFolderPlus,
  deleteNamespace: faTrashCan,
  deleteResource: faTrashCan,
  purge: faTrashCan,
  linkCatalogApp: faLink,
  unlinkCatalogApp: faLinkSlash,
  command: faTerminal,
  applyManifest: faBoxOpen,
};

export function iconForKind(kind: string): IconDefinition {
  return ICONS[kind] ?? faWrench;
}
