// Map action kinds → lucide-react icons. Mirrors the Swift SF Symbol mapping in
// SuggestedAction.systemImage (restart→arrow.clockwise, scale→arrow.up.arrow.down,
// …). See docs/parity/contracts.md § 1 for the full kind list.
//
// SF Symbol → Lucide equivalent:
//   arrow.clockwise→RotateCw, arrow.up.arrow.down→ArrowUpDown,
//   arrow.uturn.backward→RotateCcw, slider.horizontal.3→Sliders,
//   shippingbox.and.arrow.backward→Package,
//   gauge.with.dots.needle.bottom.50percent→Gauge, pause.circle→PauseCircle,
//   play.circle→PlayCircle, trash→Trash2, nosign→Ban,
//   checkmark.circle→CheckCircle2, square.stack.3d.up.slash→Box, bolt.fill→Zap,
//   plus.rectangle.on.folder→FolderPlus, link→Link, link.badge.plus→Unlink,
//   terminal→Terminal.
import {
  RotateCw,
  ArrowUpDown,
  RotateCcw,
  Sliders,
  Package,
  Gauge,
  PauseCircle,
  PlayCircle,
  Trash2,
  Ban,
  CheckCircle2,
  Box,
  Zap,
  FolderPlus,
  Link,
  Unlink,
  Terminal,
  PackagePlus,
  Wrench,
  type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  restart: RotateCw,
  scale: ArrowUpDown,
  rollback: RotateCcw,
  setEnv: Sliders,
  setImage: Package,
  setResources: Gauge,
  pause: PauseCircle,
  resume: PlayCircle,
  deletePod: Trash2,
  deleteWorkload: Trash2,
  cordon: Ban,
  uncordon: CheckCircle2,
  drain: Box,
  suspendCronJob: PauseCircle,
  resumeCronJob: PlayCircle,
  triggerCronJob: Zap,
  createNamespace: FolderPlus,
  deleteNamespace: Trash2,
  deleteResource: Trash2,
  purge: Trash2,
  linkCatalogApp: Link,
  unlinkCatalogApp: Unlink,
  command: Terminal,
  applyManifest: PackagePlus,
};

export function iconForKind(kind: string): LucideIcon {
  return ICONS[kind] ?? Wrench;
}
