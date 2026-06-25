import type { ComponentType } from "react";
import {
  Monitor, Laptop, Server, ServerCog, HardDrive, Database, Cloud, CloudCog,
  Box, Boxes, Container, Cpu, Network, Globe, House, Building2, Factory, Warehouse,
  FlaskConical, Rocket, Shield, ShieldCheck, Lock, Zap, Activity, Layers,
  Hexagon, Circle, CircleDot, Square, Star, Heart, Flag, Anchor, Cog, Terminal,
  GitBranch, Folder, Tag,
} from "lucide-react";
import { FaAws } from "react-icons/fa";
import { SiGooglecloud, SiDigitalocean, SiKubernetes, SiDocker } from "react-icons/si";
import { VscAzure } from "react-icons/vsc";
import type { ProviderKind } from "./clusterTile";

/** An icon a cluster tile can display. */
export type IconId =
  | "aws" | "gcp" | "azure" | "digitalocean" | "kubernetes" | "docker"
  | "monitor" | "laptop" | "server" | "servercog" | "harddrive" | "database"
  | "cloud" | "cloudcog" | "box" | "boxes" | "container" | "cpu" | "network" | "globe"
  | "home" | "building" | "factory" | "warehouse"
  | "flask" | "rocket" | "shield" | "shieldcheck" | "lock" | "zap" | "activity" | "layers"
  | "hexagon" | "circle" | "circledot" | "square" | "star" | "heart" | "flag" | "anchor"
  | "cog" | "terminal" | "gitbranch" | "folder" | "tag";

type IconComponent = ComponentType<{ size?: number; className?: string }>;
type IconEntry = { label: string; Component: IconComponent };
// react-icons components type their props via SVGProps; cast to the shared shape
// (both lucide and react-icons accept size + className at runtime).
const brand = (c: unknown) => c as IconComponent;

/** id → label + component. Brand marks (react-icons) + general icons (lucide).
 *  `label` is the tile tooltip and is searchable in the icon picker. */
export const CLUSTER_ICONS: Record<IconId, IconEntry> = {
  // Cloud providers (brand marks). react-icons/si lacks AWS + Azure in v5.6.0,
  // so AWS uses FaAws (Font Awesome) and Azure uses VscAzure (VS Code icons).
  aws: { label: "Amazon Web Services", Component: brand(FaAws) },
  gcp: { label: "Google Cloud", Component: brand(SiGooglecloud) },
  azure: { label: "Microsoft Azure", Component: brand(VscAzure) },
  digitalocean: { label: "DigitalOcean", Component: brand(SiDigitalocean) },
  kubernetes: { label: "Kubernetes", Component: brand(SiKubernetes) },
  docker: { label: "Docker", Component: brand(SiDocker) },
  // Infrastructure
  monitor: { label: "Monitor / local", Component: Monitor },
  laptop: { label: "Laptop", Component: Laptop },
  server: { label: "Server", Component: Server },
  servercog: { label: "Server config", Component: ServerCog },
  harddrive: { label: "Storage", Component: HardDrive },
  database: { label: "Database", Component: Database },
  cloud: { label: "Cloud", Component: Cloud },
  cloudcog: { label: "Cloud config", Component: CloudCog },
  box: { label: "Box", Component: Box },
  boxes: { label: "Cluster", Component: Boxes },
  container: { label: "Container", Component: Container },
  cpu: { label: "CPU", Component: Cpu },
  network: { label: "Network", Component: Network },
  globe: { label: "Globe / public", Component: Globe },
  // Places
  home: { label: "Home / homelab", Component: House },
  building: { label: "Org / on-prem", Component: Building2 },
  factory: { label: "Factory", Component: Factory },
  warehouse: { label: "Warehouse", Component: Warehouse },
  // Purpose / environment
  flask: { label: "Dev / test", Component: FlaskConical },
  rocket: { label: "Production", Component: Rocket },
  shield: { label: "Secure", Component: Shield },
  shieldcheck: { label: "Verified", Component: ShieldCheck },
  lock: { label: "Locked", Component: Lock },
  zap: { label: "Fast / edge", Component: Zap },
  activity: { label: "Activity", Component: Activity },
  layers: { label: "Layers", Component: Layers },
  // Shapes / misc
  hexagon: { label: "Hexagon", Component: Hexagon },
  circle: { label: "Circle", Component: Circle },
  circledot: { label: "Dot", Component: CircleDot },
  square: { label: "Square", Component: Square },
  star: { label: "Star", Component: Star },
  heart: { label: "Heart", Component: Heart },
  flag: { label: "Flag", Component: Flag },
  anchor: { label: "Anchor", Component: Anchor },
  cog: { label: "Settings", Component: Cog },
  terminal: { label: "Terminal", Component: Terminal },
  gitbranch: { label: "Git", Component: GitBranch },
  folder: { label: "Folder", Component: Folder },
  tag: { label: "Tag", Component: Tag },
};

/** Order of icons in the picker grid (providers first, then infra, places, etc.). */
export const ICON_PALETTE: IconId[] = [
  "aws", "gcp", "azure", "digitalocean", "kubernetes", "docker",
  "monitor", "laptop", "server", "servercog", "harddrive", "database",
  "cloud", "cloudcog", "box", "boxes", "container", "cpu", "network", "globe",
  "home", "building", "factory", "warehouse",
  "flask", "rocket", "shield", "shieldcheck", "lock", "zap", "activity", "layers",
  "hexagon", "circle", "circledot", "square", "star", "heart", "flag", "anchor",
  "cog", "terminal", "gitbranch", "folder", "tag",
];

/** The auto-detected default icon for a provider class. */
export function providerDefaultIcon(kind: ProviderKind): IconId {
  switch (kind) {
    case "local": return "monitor";
    case "aws": return "aws";
    case "gcp": return "gcp";
    case "azure": return "azure";
    case "digitalocean": return "digitalocean";
    case "generic": return "kubernetes";
  }
}
