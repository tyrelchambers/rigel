import type { ComponentType, CSSProperties } from "react";
import { FontAwesomeIcon, type FontAwesomeIconProps } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faDisplay, faLaptop, faServer, faHardDrive, faDatabase, faCloud, faCube,
  faBoxesStacked, faBox, faMicrochip, faNetworkWired, faGlobe, faHouse, faBuilding,
  faIndustry, faWarehouse, faFlask, faRocket, faShield, faShieldCheck, faLock,
  faBolt, faWaveform, faLayerGroup, faHexagon, faCircle, faCircleDot, faSquare,
  faStar, faHeart, faFlag, faAnchor, faGear, faTerminal, faCodeBranch, faFolder, faTag,
} from "@awesome.me/kit-6050953220/icons/classic/solid";
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

type IconComponent = ComponentType<{ size?: number; className?: string; style?: CSSProperties }>;
/** A tile glyph is either a Font Awesome icon (general icons) or a react-icons
 *  brand component (cloud providers, which the FA kit has no marks for). */
type ClusterGlyph = IconDefinition | IconComponent;
type IconEntry = { label: string; icon: ClusterGlyph };
// react-icons components type their props via SVGProps; cast to the shared shape.
const brand = (c: unknown) => c as IconComponent;

/** id → label + glyph. Brand marks (react-icons) + general icons (Font Awesome).
 *  `label` is the tile tooltip and is searchable in the icon picker. */
export const CLUSTER_ICONS: Record<IconId, IconEntry> = {
  // Cloud providers (brand marks). The FA kit ships no brand family, so these
  // stay as react-icons: AWS uses FaAws, Azure uses VscAzure (VS Code icons).
  aws: { label: "Amazon Web Services", icon: brand(FaAws) },
  gcp: { label: "Google Cloud", icon: brand(SiGooglecloud) },
  azure: { label: "Microsoft Azure", icon: brand(VscAzure) },
  digitalocean: { label: "DigitalOcean", icon: brand(SiDigitalocean) },
  kubernetes: { label: "Kubernetes", icon: brand(SiKubernetes) },
  docker: { label: "Docker", icon: brand(SiDocker) },
  // Infrastructure
  monitor: { label: "Monitor / local", icon: faDisplay },
  laptop: { label: "Laptop", icon: faLaptop },
  server: { label: "Server", icon: faServer },
  servercog: { label: "Server config", icon: faServer },
  harddrive: { label: "Storage", icon: faHardDrive },
  database: { label: "Database", icon: faDatabase },
  cloud: { label: "Cloud", icon: faCloud },
  cloudcog: { label: "Cloud config", icon: faCloud },
  box: { label: "Box", icon: faCube },
  boxes: { label: "Cluster", icon: faBoxesStacked },
  container: { label: "Container", icon: faBox },
  cpu: { label: "CPU", icon: faMicrochip },
  network: { label: "Network", icon: faNetworkWired },
  globe: { label: "Globe / public", icon: faGlobe },
  // Places
  home: { label: "Home / homelab", icon: faHouse },
  building: { label: "Org / on-prem", icon: faBuilding },
  factory: { label: "Factory", icon: faIndustry },
  warehouse: { label: "Warehouse", icon: faWarehouse },
  // Purpose / environment
  flask: { label: "Dev / test", icon: faFlask },
  rocket: { label: "Production", icon: faRocket },
  shield: { label: "Secure", icon: faShield },
  shieldcheck: { label: "Verified", icon: faShieldCheck },
  lock: { label: "Locked", icon: faLock },
  zap: { label: "Fast / edge", icon: faBolt },
  activity: { label: "Activity", icon: faWaveform },
  layers: { label: "Layers", icon: faLayerGroup },
  // Shapes / misc
  hexagon: { label: "Hexagon", icon: faHexagon },
  circle: { label: "Circle", icon: faCircle },
  circledot: { label: "Dot", icon: faCircleDot },
  square: { label: "Square", icon: faSquare },
  star: { label: "Star", icon: faStar },
  heart: { label: "Heart", icon: faHeart },
  flag: { label: "Flag", icon: faFlag },
  anchor: { label: "Anchor", icon: faAnchor },
  cog: { label: "Settings", icon: faGear },
  terminal: { label: "Terminal", icon: faTerminal },
  gitbranch: { label: "Git", icon: faCodeBranch },
  folder: { label: "Folder", icon: faFolder },
  tag: { label: "Tag", icon: faTag },
};

/** Render a cluster glyph by id. Handles both Font Awesome icon defs and the
 *  react-icons brand components. Pass sizing via a static `className` (e.g.
 *  `size-[18px]`) so both families size identically. */
export function ClusterIcon({
  id,
  className,
  style,
}: {
  id: IconId;
  className?: string;
  style?: CSSProperties;
}) {
  const { icon } = CLUSTER_ICONS[id];
  if (typeof icon === "function") {
    const Glyph = icon;
    return <Glyph className={className} style={style} />;
  }
  return <FontAwesomeIcon icon={icon} className={className} style={style as FontAwesomeIconProps["style"]} />;
}

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
