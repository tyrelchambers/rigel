// Map action kinds → lucide-react icons. Mirrors the Swift SF Symbol mapping
// (restart→arrow.clockwise, scale→arrow.up.arrow.down, etc.).
import {
  RotateCw,
  ArrowUpDown,
  Undo2,
  Variable,
  Container,
  Cpu,
  Pause,
  Play,
  Trash2,
  Ban,
  CircleCheck,
  Droplet,
  Clock,
  Plus,
  FolderMinus,
  FlameKindling,
  Terminal,
  PackagePlus,
  Wrench,
  type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  restart: RotateCw,
  scale: ArrowUpDown,
  rollback: Undo2,
  setEnv: Variable,
  setImage: Container,
  setResources: Cpu,
  pause: Pause,
  resume: Play,
  deletePod: Trash2,
  deleteWorkload: Trash2,
  cordon: Ban,
  uncordon: CircleCheck,
  drain: Droplet,
  suspendCronJob: Pause,
  resumeCronJob: Play,
  triggerCronJob: Clock,
  createNamespace: Plus,
  deleteNamespace: FolderMinus,
  deleteResource: Trash2,
  purge: FlameKindling,
  command: Terminal,
  applyManifest: PackagePlus,
};

export function iconForKind(kind: string): LucideIcon {
  return ICONS[kind] ?? Wrench;
}
